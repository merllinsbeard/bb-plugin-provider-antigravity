import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AGY_STATE_DIR, AGY_TOKEN_FILE } from "../identity.ts";
import { readEgress, routeEnv, type Route, type Unusable } from "./egress.ts";

export const DEFAULT_ACCOUNT = "default" as AccountName;

declare const accountNameBrand: unique symbol;
export type AccountName = string & { readonly [accountNameBrand]: true };

/** Marker file in an account folder that takes the account out of automatic picking (`agy-pool disable`). */
export const DISABLED_FILE = "agy-pool-disabled";

type AccountBase = {
  readonly name: AccountName;
  readonly dir: string;
  /** The owner took the account out of automatic picking and failover; `AGY_POOL_ACCOUNT` still reaches it. */
  readonly disabled: boolean;
  /** First line of the marker file, when the owner gave a reason. */
  readonly disabledReason: string | null;
};

export type UsableAccount = AccountBase & { readonly egress: Route };

export type BrokenAccount = AccountBase & { readonly egress: Unusable };

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

function readDisabled(dir: string): Pick<AccountBase, "disabled" | "disabledReason"> {
  let text: string;
  try {
    text = readFileSync(path.join(dir, DISABLED_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { disabled: false, disabledReason: null };
    // A marker that exists but cannot be read still means the owner disabled the account.
    return { disabled: true, disabledReason: null };
  }
  const reason = text.split("\n")[0]!.trim();
  return { disabled: true, disabledReason: reason === "" ? null : reason };
}

export function account(name: AccountName, dir: string): Account {
  const egress = readEgress(dir);
  const toggle = readDisabled(dir);
  return egress.kind === "invalid" ? { name, dir, ...toggle, egress } : { name, dir, ...toggle, egress };
}

/** Writes or removes the disabled marker. Idempotent: enabling an enabled account and re-disabling both converge. */
export function setDisabled(account: Account, disabled: boolean, reason: string | null): void {
  const file = path.join(account.dir, DISABLED_FILE);
  if (!disabled) return rmSync(file, { force: true });
  writeFileSync(file, `${reason ?? ""}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
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
export function shareConversations(paths: PoolPaths, account: Account): number {
  let migrated = 0;
  for (const dir of SHARED_DIRS) {
    const store = path.join(paths.agyStateDir, dir);
    mkdirSync(store, { recursive: true });
    if (account.name === DEFAULT_ACCOUNT) continue;
    const own = path.join(account.dir, dir);
    if (!isDirectory(own)) continue;
    for (const entry of readdirSync(own)) {
      const target = path.join(store, entry);
      if (!existsSync(target)) {
        renameSync(path.join(own, entry), target);
        migrated++;
      }
    }
  }
  return migrated;
}

export type SettingsSyncStatus = "default" | "unchanged" | "updated" | "missing-source";

export type AccountSyncResult = {
  readonly account: AccountName;
  readonly dir: string;
  readonly authenticated: boolean;
  readonly settings: SettingsSyncStatus;
  readonly migratedConversations: number;
};

/**
 * Keeps user-editable settings (`settings.json`) and shared conversation folders
 * synchronized from the default account into an added account directory without
 * touching account-specific identity, auth, proxy, or runtime state files.
 * Idempotent and atomic.
 */
export function syncAccountConfig(paths: PoolPaths, account: Account): AccountSyncResult {
  const authenticated = isAuthenticated(account);
  const migratedConversations = shareConversations(paths, account);
  if (account.name === DEFAULT_ACCOUNT) {
    return { account: account.name, dir: account.dir, authenticated, settings: "default", migratedConversations };
  }
  mkdirSync(account.dir, { recursive: true, mode: 0o700 });
  const sourceFile = path.join(paths.agyStateDir, "settings.json");
  if (!existsSync(sourceFile)) {
    return { account: account.name, dir: account.dir, authenticated, settings: "missing-source", migratedConversations };
  }
  const sourceBytes = readFileSync(sourceFile);
  const targetFile = path.join(account.dir, "settings.json");
  if (existsSync(targetFile) && readFileSync(targetFile).equals(sourceBytes)) {
    return { account: account.name, dir: account.dir, authenticated, settings: "unchanged", migratedConversations };
  }
  const tmpFile = path.join(account.dir, `.settings.json.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmpFile, sourceBytes, { mode: 0o600 });
  chmodSync(tmpFile, 0o600);
  renameSync(tmpFile, targetFile);
  return { account: account.name, dir: account.dir, authenticated, settings: "updated", migratedConversations };
}

export const SHARED_GEMINI_FILES = [
  "AGENTS.md",
  "config/skills.json",
  "config/mcp_config.json",
  "config/hooks.json",
  "config/config.json",
] as const;

export function sharedGeminiConfigStatus(home: string): Record<(typeof SHARED_GEMINI_FILES)[number], boolean> {
  const geminiRoot = path.join(home, ".gemini");
  return Object.fromEntries(SHARED_GEMINI_FILES.map((rel) => [rel, existsSync(path.join(geminiRoot, rel))])) as Record<
    (typeof SHARED_GEMINI_FILES)[number],
    boolean
  >;
}
