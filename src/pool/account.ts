import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import { AGY_STATE_DIR, AGY_TOKEN_FILE } from "../identity.ts";
import { readEgress, routeEnv, type Route, type Unusable } from "./egress.ts";

export const DEFAULT_ACCOUNT = "default" as AccountName;

declare const accountNameBrand: unique symbol;
export type AccountName = string & { readonly [accountNameBrand]: true };

export type UsableAccount = { readonly name: AccountName; readonly dir: string; readonly egress: Route };

export type BrokenAccount = { readonly name: AccountName; readonly dir: string; readonly egress: Unusable };

export type Account = UsableAccount | BrokenAccount;

export type PoolPaths = {
  readonly agyStateDir: string;
  readonly accountsRoot: string;
  readonly bindingsFile: string;
};

export type Command = {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
};

const NAME = /^[a-z0-9][a-z0-9_-]{0,15}$/;

export function parseAccountName(raw: string): AccountName | null {
  return NAME.test(raw) ? (raw as AccountName) : null;
}

export function poolPaths(env: NodeJS.ProcessEnv, home: string): PoolPaths {
  return {
    agyStateDir: path.join(home, AGY_STATE_DIR),
    accountsRoot: env.AGY_POOL_ACCOUNTS_DIR || path.join(home, ".local", "share", "agy-accounts"),
    bindingsFile: path.join(env.AGY_POOL_STATE_DIR || path.join(home, ".local", "state", "agy-pool"), "bindings.json"),
  };
}

function isDirectory(file: string): boolean {
  try {
    return statSync(file).isDirectory();
  } catch {
    return false;
  }
}

export function listAccounts(paths: PoolPaths): Account[] {
  const added = isDirectory(paths.accountsRoot)
    ? readdirSync(paths.accountsRoot)
        .sort()
        .flatMap((entry) => {
          const name = parseAccountName(entry);
          const dir = path.join(paths.accountsRoot, entry);
          return name !== null && name !== DEFAULT_ACCOUNT && isDirectory(dir) ? [account(name, dir)] : [];
        })
    : [];
  return [account(DEFAULT_ACCOUNT, paths.agyStateDir), ...added];
}

export function account(name: AccountName, dir: string): Account {
  const egress = readEgress(dir);
  return egress.kind === "invalid" ? { name, dir, egress } : { name, dir, egress };
}

export function isUsable(account: Account): account is UsableAccount {
  return account.egress.kind !== "invalid";
}

export function isAuthenticated(account: Account): boolean {
  return existsSync(path.join(account.dir, AGY_TOKEN_FILE));
}

export function readAccountEmail(account: Account): string | null {
  try {
    const token: unknown = JSON.parse(readFileSync(path.join(account.dir, AGY_TOKEN_FILE), "utf8"));
    const email = (token as { id_token_email?: unknown } | null)?.id_token_email;
    return typeof email === "string" && email.trim() !== "" ? email.trim() : null;
  } catch {
    return null;
  }
}

/**
 * agy keeps each conversation as `conversations/<id>.db` (SQLite, with
 * `-wal`/`-shm`/`-journal` sidecars), `brain/<id>/` and `annotations/<id>.pbtxt`.
 * Every account sees the default account's folders, so a thread can move to
 * another account and `session/load` finds its history there.
 */
export const SHARED_DIRS = ["conversations", "brain", "annotations"] as const;

export function accountCommand(
  paths: PoolPaths,
  account: UsableAccount,
  agy: string,
  args: readonly string[],
  options?: { readonly shareConversations?: boolean },
): Command {
  const env = routeEnv(account.egress);
  if (account.name === DEFAULT_ACCOUNT) return { command: agy, args, env };
  const shared = options?.shareConversations
    ? SHARED_DIRS.flatMap((dir) => ["--bind", path.join(paths.agyStateDir, dir), path.join(paths.agyStateDir, dir)])
    : [];
  return {
    command: "bwrap",
    args: ["--dev-bind", "/", "/", "--bind", account.dir, paths.agyStateDir, ...shared, agy, ...args],
    env,
  };
}

/**
 * Moves conversations an added account wrote into its own folders (before the
 * store was shared) into the shared store, then makes sure every shared folder
 * exists. An id the store already holds stays where it is. Idempotent.
 */
export function shareConversations(paths: PoolPaths, account: Account): void {
  for (const dir of SHARED_DIRS) {
    const store = path.join(paths.agyStateDir, dir);
    mkdirSync(store, { recursive: true });
    if (account.name === DEFAULT_ACCOUNT) continue;
    const own = path.join(account.dir, dir);
    if (!isDirectory(own)) continue;
    for (const entry of readdirSync(own)) {
      const target = path.join(store, entry);
      if (!existsSync(target)) renameSync(path.join(own, entry), target);
    }
  }
}
