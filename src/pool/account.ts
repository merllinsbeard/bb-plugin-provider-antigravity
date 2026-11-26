import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AGY_STATE_DIR, AGY_TOKEN_FILE } from "../identity.ts";
import { readEgress, routeEnv, type Route, type Unusable } from "./egress.ts";

export const DEFAULT_ACCOUNT = "default" as AccountName;

declare const accountNameBrand: unique symbol;
export type AccountName = string & { readonly [accountNameBrand]: true };

/** Marker file in an account folder that takes the account out of automatic picking (`agy-pool disable`). */
export const DISABLED_FILE = "agy-pool-disabled";

/**
 * Per-account machine id, bound read-only over `/etc/machine-id` inside the
 * account's sandbox so added accounts do not report the host's id (and
 * `/var/lib/dbus/machine-id`, a symlink to it on this host, follows along).
 */
export const MACHINE_ID_FILE = "agy-pool-machine-id";
export const HOST_MACHINE_ID = "/etc/machine-id";
/** Host files that may hold the machine id; a symlink among them already follows `/etc/machine-id`. */
const HOST_MACHINE_ID_FILES = [HOST_MACHINE_ID, "/var/lib/dbus/machine-id"] as const;
const MACHINE_ID = /^[0-9a-f]{32}\n?$/;

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
  mkdirSync(account.dir, { recursive: true, mode: 0o700 });
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

/**
 * Gives an account folder its own machine id (32 lowercase hex and a newline,
 * mode 0600) unless it already holds a valid one in a regular file. Idempotent;
 * written through a temp file so a crash never leaves a half-written id, and
 * two first starts agree on one id. Null when the folder cannot take the file;
 * the account then runs with the host's id.
 */
export function ensureMachineId(accountDir: string): string | null {
  const file = path.join(accountDir, MACHINE_ID_FILE);
  if (isRegularFile(file) && MACHINE_ID.test(readFileSync(file, "utf8"))) return file;
  mkdirSync(accountDir, { recursive: true, mode: 0o700 });
  const tmpFile = path.join(accountDir, `.${MACHINE_ID_FILE}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tmpFile, `${randomBytes(16).toString("hex")}\n`, { mode: 0o600, flag: "wx" });
    chmodSync(tmpFile, 0o600);
    try {
      // Creating with link() fails when another start created the id first; that id wins.
      linkSync(tmpFile, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!(isRegularFile(file) && MACHINE_ID.test(readFileSync(file, "utf8")))) renameSync(tmpFile, file);
    }
    return file;
  } catch {
    return null;
  } finally {
    rmSync(tmpFile, { force: true });
  }
}

function isRegularFile(file: string): boolean {
  try {
    return lstatSync(file).isFile();
  } catch {
    return false;
  }
}

export function accountCommand(
  paths: PoolPaths,
  account: UsableAccount,
  agy: string,
  args: readonly string[],
  options?: { readonly shareConversations?: boolean },
): Command {
  const env = routeEnv(account.egress);
  if (account.name === DEFAULT_ACCOUNT) return { command: agy, args, env };
  const machineId = path.join(account.dir, MACHINE_ID_FILE);
  const identity = isRegularFile(machineId)
    ? [
        ...HOST_MACHINE_ID_FILES.flatMap((target) => (isRegularFile(target) ? ["--ro-bind", machineId, target] : [])),
        "--ro-bind",
        machineId,
        path.join(paths.agyStateDir, MACHINE_ID_FILE),
      ]
    : [];
  const shared = options?.shareConversations
    ? SHARED_DIRS.flatMap((dir) => ["--bind", path.join(paths.agyStateDir, dir), path.join(paths.agyStateDir, dir)])
    : [];
  return {
    command: "bwrap",
    args: ["--dev-bind", "/", "/", "--bind", account.dir, paths.agyStateDir, ...identity, ...shared, agy, ...args],
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
  ensureMachineId(account.dir);
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
