import type { ProviderQuota } from "../usage/types.ts";
import {
  DEFAULT_ACCOUNT,
  isAuthenticated,
  listAccounts,
  parseAccountName,
  type Account,
  type PoolPaths,
} from "./account.ts";
import { liveThreadCounts, readBindings, writeBindings } from "./bindings.ts";
import { pickAccount } from "./pick.ts";

export type LaunchRequest = {
  readonly threadId: string | null;
  readonly requestedAccount: string | null;
  readonly pid: number;
};

export type ResolvePorts = {
  readonly paths: PoolPaths;
  readonly readQuota: (account: Account) => Promise<ProviderQuota | null>;
  readonly isAlive?: (threadId: string, pid: number) => boolean;
  readonly now?: () => Date;
};

export type Resolution =
  | { readonly ok: true; readonly account: Account }
  | { readonly ok: false; readonly message: string };

function byName(accounts: readonly Account[], raw: string): Account | undefined {
  const name = parseAccountName(raw);
  return accounts.find((account) => account.name === name);
}

export async function resolveAccount(ports: ResolvePorts, request: LaunchRequest): Promise<Resolution> {
  const accounts = listAccounts(ports.paths);
  if (request.threadId === null || request.requestedAccount !== null) {
    const name = request.requestedAccount ?? DEFAULT_ACCOUNT;
    const account = byName(accounts, name);
    return account ? { ok: true, account } : { ok: false, message: `agy-pool: no account named "${name}".` };
  }
  const threadId = request.threadId;
  const bindings = readBindings(ports.paths.bindingsFile);
  const bound = bindings.get(threadId);
  const boundAt = (ports.now ?? (() => new Date()))().toISOString();
  const record = (account: Account, since: string) => {
    const next = new Map(bindings);
    next.set(threadId, { account: account.name, pid: request.pid, boundAt: since });
    writeBindings(ports.paths.bindingsFile, next);
    return { ok: true as const, account };
  };
  if (bound) {
    const account = byName(accounts, bound.account);
    return account
      ? record(account, bound.boundAt)
      : { ok: false, message: `agy-pool: thread ${threadId} is bound to account "${bound.account}", which no longer exists.` };
  }
  const authenticated = accounts.filter(isAuthenticated);
  const live = liveThreadCounts(bindings, ports.isAlive);
  const candidates = await Promise.all(
    authenticated.map(async (account) => ({
      name: account.name,
      quota: authenticated.length > 1 ? await ports.readQuota(account) : null,
      liveThreads: live.get(account.name) ?? 0,
    })),
  );
  const pick = pickAccount(candidates);
  if (pick.ok) return record(byName(accounts, pick.account)!, boundAt);
  if (pick.reason === "no-authenticated-account")
    return { ok: false, message: "agy-pool: no signed-in Antigravity account. Run `agy-pool login <name>` or `agy acp --login`." };
  const reset = pick.nearestReset;
  return {
    ok: false,
    message: reset
      ? `agy-pool: every Antigravity account is out of quota. The nearest reset is ${reset.at} (account "${reset.account}").`
      : "agy-pool: every Antigravity account is out of quota.",
  };
}
