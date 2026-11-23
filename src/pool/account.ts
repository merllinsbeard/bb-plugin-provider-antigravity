import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { AGY_STATE_DIR, AGY_TOKEN_FILE } from "../identity.ts";

export const DEFAULT_ACCOUNT = "default" as AccountName;

declare const accountNameBrand: unique symbol;
export type AccountName = string & { readonly [accountNameBrand]: true };

export type Account = { readonly name: AccountName; readonly dir: string };

export type PoolPaths = {
  readonly agyStateDir: string;
  readonly accountsRoot: string;
  readonly bindingsFile: string;
};

export type Command = { readonly command: string; readonly args: readonly string[] };

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
          return name !== null && name !== DEFAULT_ACCOUNT && isDirectory(dir) ? [{ name, dir }] : [];
        })
    : [];
  return [{ name: DEFAULT_ACCOUNT, dir: paths.agyStateDir }, ...added];
}

export function isAuthenticated(account: Account): boolean {
  return existsSync(path.join(account.dir, AGY_TOKEN_FILE));
}

export function accountCommand(paths: PoolPaths, account: Account, agy: string, args: readonly string[]): Command {
  if (account.name === DEFAULT_ACCOUNT) return { command: agy, args };
  return {
    command: "bwrap",
    args: ["--dev-bind", "/", "/", "--bind", account.dir, paths.agyStateDir, agy, ...args],
  };
}
