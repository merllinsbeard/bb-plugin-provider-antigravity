import type { ProviderQuota } from "../usage/types.ts";
import {
  DEFAULT_ACCOUNT,
  type AccountName,
  isAuthenticated,
  isUsable,
  listAccounts,
  parseAccountName,
  type Account,
  type PoolPaths,
  type UsableAccount,
} from "./account.ts";
import { liveThreadCounts, readBindings, writeBindings } from "./bindings.ts";
import { exhaustedUntil, type Exhausted } from "./exhaustion.ts";
import { familyLabel, type ModelFamily } from "./family.ts";
import { pickAccount } from "./pick.ts";

export type LaunchRequest = {
  readonly threadId: string | null;
  readonly requestedAccount: string | null;
  readonly pid: number;
  /** The model family the thread needs, known once its session chose a model; null at first start. */
  readonly family: ModelFamily | null;
  /** Accounts agy refused for the prompt being moved; they are skipped even when the family is unknown. */
  readonly refused: readonly AccountName[];
};

export type ResolvePorts = {
  readonly paths: PoolPaths;
  readonly readQuota: (account: Account) => Promise<ProviderQuota | null>;
  readonly isAlive?: (threadId: string, pid: number) => boolean;
  readonly now?: () => Date;
  /** Account and family pairs agy refused for quota, with the time each is usable again (`exhaustion.ts`). */
  readonly exhausted?: Exhausted;
};

export type Resolution =
  | { readonly ok: true; readonly account: UsableAccount }
  | { readonly ok: false; readonly message: string };

function byName<A extends Account>(accounts: readonly A[], raw: string): A | undefined {
  const name = parseAccountName(raw);
  return accounts.find((account) => account.name === name);
}

function launchable(account: Account): Resolution {
  return isUsable(account)
    ? { ok: true, account }
    : { ok: false, message: `agy-pool: account "${account.name}" is unusable: ${account.egress.problem}` };
}

export async function resolveAccount(ports: ResolvePorts, request: LaunchRequest): Promise<Resolution> {
  const accounts = listAccounts(ports.paths);
  if (request.threadId === null || request.requestedAccount !== null) {
    const name = request.requestedAccount ?? DEFAULT_ACCOUNT;
    const account = byName(accounts, name);
    if (!account) return { ok: false, message: `agy-pool: no account named "${name}".` };
    return launchable(account);
  }
  const threadId = request.threadId;
  const bindings = readBindings(ports.paths.bindingsFile);
  const bound = bindings.get(threadId);
  const boundAt = (ports.now ?? (() => new Date()))().toISOString();
  const record = (account: UsableAccount, since: string) => {
    const next = new Map(bindings);
    next.set(threadId, { account: account.name, pid: request.pid, boundAt: since });
    writeBindings(ports.paths.bindingsFile, next);
    return { ok: true as const, account };
  };
  const exhausted = ports.exhausted ?? new Map();
  const family = request.family;
  const markedUntil = (name: AccountName) => (family === null ? undefined : exhaustedUntil(exhausted, name, family));
  const outOf = (name: AccountName) => request.refused.includes(name) || markedUntil(name) !== undefined;
  const outOfQuota = family === null ? "out of quota" : `out of ${familyLabel(family)} quota`;
  // A thread keeps its account until agy refuses it for the family the thread
  // uses. Conversations live in one store shared by every account, so moving
  // is lossless.
  if (bound && !outOf(bound.account)) {
    const account = byName(accounts, bound.account);
    if (!account)
      return { ok: false, message: `agy-pool: thread ${threadId} is bound to account "${bound.account}", which no longer exists.` };
    const resolved = launchable(account);
    return resolved.ok ? record(resolved.account, bound.boundAt) : resolved;
  }
  const signedIn = accounts.filter(isUsable).filter(isAuthenticated);
  const authenticated = signedIn.filter((account) => !outOf(account.name));
  if (authenticated.length === 0 && signedIn.length > 0) {
    const [nearest] = signedIn
      .flatMap((account) => {
        const until = markedUntil(account.name);
        return until === undefined ? [] : [[account.name, until] as const];
      })
      .sort((a, b) => a[1].localeCompare(b[1]));
    return {
      ok: false,
      message: nearest
        ? `agy-pool: every Antigravity account is ${outOfQuota}. The nearest reset is ${nearest[1]} (account "${nearest[0]}").`
        : `agy-pool: every Antigravity account is ${outOfQuota}.`,
    };
  }
  const live = liveThreadCounts(bindings, ports.isAlive);
  const candidates = await Promise.all(
    authenticated.map(async (account) => ({
      name: account.name,
      quota: authenticated.length > 1 ? await ports.readQuota(account) : null,
      liveThreads: live.get(account.name) ?? 0,
    })),
  );
  const pick = pickAccount(candidates, family);
  if (pick.ok) return record(byName(authenticated, pick.account)!, boundAt);
  if (pick.reason === "no-authenticated-account") {
    const broken = accounts.flatMap((account) => (account.egress.kind === "invalid" ? [account.egress.problem] : []));
    return {
      ok: false,
      message: [
        "agy-pool: no signed-in Antigravity account. Run `agy-pool login <name>` or `agy acp --login`.",
        ...broken.map((problem) => `Skipped: ${problem}`),
      ].join("\n"),
    };
  }
  const reset = pick.nearestReset;
  return {
    ok: false,
    message: reset
      ? `agy-pool: every Antigravity account is ${outOfQuota}. The nearest reset is ${reset.at} (account "${reset.account}").`
      : `agy-pool: every Antigravity account is ${outOfQuota}.`,
  };
}
