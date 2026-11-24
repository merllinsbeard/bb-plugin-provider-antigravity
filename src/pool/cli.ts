import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveAgyBinary } from "../usage/probe.ts";
import {
  DEFAULT_ACCOUNT,
  account as readAccount,
  accountCommand,
  isAuthenticated,
  isUsable,
  listAccounts,
  parseAccountName,
  poolPaths,
  sharedGeminiConfigStatus,
  syncAccountConfig,
  type Account,
  type Command,
} from "./account.ts";
import { PROXY_FILE, parseProxyUrl, type ProxyRoute } from "./egress.ts";
import { liveThreadCounts, readBindings } from "./bindings.ts";
import { exhaustionFile, markExhausted, readExhausted } from "./exhaustion.ts";
import { parseModelFamily } from "./family.ts";
import { resolveAccount } from "./launcher.ts";
import { probeAccount } from "./probe-account.ts";

const home = os.homedir();
const paths = poolPaths(process.env, home);
const locateBinary = () => resolveAgyBinary(process.env, home);

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function requireAgy(): string {
  return locateBinary() ?? fail("agy-pool: agy is not installed (set BB_ANTIGRAVITY_EXECUTABLE or put agy on PATH).");
}

function printPrefix({ command, args, env }: Command): void {
  const exports = Object.entries(env).map(([key, value]) => `${key}=${value}`);
  process.stdout.write([...exports, "--", command, ...args].join("\n"));
}

const IP_CHECK_URL = "http://ip-api.com/json?fields=status,countryCode,query";

function checkProxy(name: string, route: ProxyRoute): void {
  const quote = (value: string) => `"${value.replace(/[\\"]/g, "\\$&")}"`;
  const run = spawnSync("curl", ["--silent", "--show-error", "--max-time", "20", "--config", "-"], {
    input: `proxy = ${quote(route.url)}\nurl = ${quote(IP_CHECK_URL)}\n`,
    encoding: "utf8",
  });
  let exit: { query?: string; countryCode?: string } | null = null;
  try {
    exit = run.status === 0 ? JSON.parse(run.stdout) : null;
  } catch {}
  if (!exit?.query)
    fail(
      `agy-pool: proxy ${route.endpoint} for account "${name}" does not work (${run.stderr.trim() || run.error?.message || "no answer"}). ` +
        `It is saved in ${PROXY_FILE}; the sign-in did not start.`,
    );
  process.stderr.write(`agy-pool: account "${name}" goes out through ${route.endpoint} as ${exit.query} (${exit.countryCode ?? "unknown country"}).\n`);
}

/** `resolve <pid> [<family> [<exhausted account> <reset ms>]]`; the family is `gemini` or `3p`. */
async function resolve(pidArg: string | undefined, rest: readonly string[]): Promise<void> {
  const pid = Number(pidArg);
  if (!Number.isInteger(pid) || pid <= 0) fail("agy-pool: resolve needs the launcher pid.");
  const [rawFamily, rawAccount, rawMs] = rest;
  const family = parseModelFamily(rawFamily ?? "");
  const exhaustedAccount = parseAccountName(rawAccount ?? "");
  const resetMs = Number(rawMs);
  if (family !== null && exhaustedAccount !== null && Number.isFinite(resetMs) && resetMs > 0)
    markExhausted(exhaustionFile(paths.bindingsFile), exhaustedAccount, family, new Date(Date.now() + resetMs));
  const agy = requireAgy();
  const resolution = await resolveAccount(
    {
      paths,
      readQuota: async (account) => {
        const outcome = await probeAccount(paths, account, () => agy);
        return outcome.ok ? outcome.quota : null;
      },
      exhausted: readExhausted(exhaustionFile(paths.bindingsFile), new Date()),
    },
    {
      threadId: process.env.BB_THREAD_ID || null,
      requestedAccount: process.env.AGY_POOL_ACCOUNT || null,
      pid,
      family,
    },
  );
  if (!resolution.ok) fail(resolution.message);
  syncAccountConfig(paths, resolution.account);
  const command = accountCommand(paths, resolution.account, agy, [], { shareConversations: true });
  printPrefix({ ...command, env: { ...command.env, AGY_POOL_RESOLVED: resolution.account.name } });
}

const LOGIN_USAGE = "agy-pool: usage `agy-pool login <name> [--proxy <url>]`; a name is 1-16 of a-z, 0-9, _ and -.";

function prepareLogin(args: readonly string[]): void {
  const [raw, flag, proxyArg, ...rest] = args;
  const name = parseAccountName(raw ?? "") ?? fail(LOGIN_USAGE);
  if (rest.length > 0 || (flag !== undefined && (flag !== "--proxy" || proxyArg === undefined))) fail(LOGIN_USAGE);
  const proxy = proxyArg === undefined ? null : parseProxyUrl(proxyArg);
  if (proxy?.kind === "invalid") fail(`agy-pool: the proxy URL ${proxy.problem}.`);
  const agy = requireAgy();
  const dir = name === DEFAULT_ACCOUNT ? paths.agyStateDir : path.join(paths.accountsRoot, name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (proxy !== null) {
    const file = path.join(dir, PROXY_FILE);
    writeFileSync(file, `${proxy.url}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
  }
  const account = readAccount(name, dir);
  if (!isUsable(account)) fail(`agy-pool: account "${name}" is unusable: ${account.egress.problem}`);
  syncAccountConfig(paths, account);
  if (account.egress.kind === "proxy") checkProxy(name, account.egress);
  printPrefix(accountCommand(paths, account, agy, []));
}

function describeEgress(account: Account): string {
  switch (account.egress.kind) {
    case "direct":
      return "direct";
    case "proxy":
      return `proxy ${account.egress.endpoint}`;
    case "invalid":
      return "unusable";
  }
}

async function list(): Promise<void> {
  const bindings = readBindings(paths.bindingsFile);
  const live = liveThreadCounts(bindings);
  const accounts = [];
  for (const account of listAccounts(paths)) {
    const outcome = await probeAccount(paths, account, locateBinary);
    accounts.push({
      name: account.name,
      dir: account.dir,
      egress: describeEgress(account),
      authenticated: isAuthenticated(account),
      boundThreads: [...bindings.values()].filter((binding) => binding.account === account.name).length,
      liveThreads: live.get(account.name) ?? 0,
      quota: outcome.ok ? outcome.reading.windows : null,
      ...(outcome.ok ? {} : { quotaStatus: outcome.failure }),
    });
  }
  process.stdout.write(`${JSON.stringify({ bindingsFile: paths.bindingsFile, accounts }, null, 2)}\n`);
}

function syncAll(): void {
  const accounts = listAccounts(paths).map((account) => syncAccountConfig(paths, account));
  const sharedRoot = path.join(home, ".gemini");
  process.stdout.write(`${JSON.stringify({ sharedRoot, sharedFiles: sharedGeminiConfigStatus(home), accounts }, null, 2)}\n`);
}

const [command, arg, ...more] = process.argv.slice(2);
switch (command) {
  case "resolve":
    await resolve(arg, more);
    break;
  case "prepare-login":
    prepareLogin([arg ?? "", ...more]);
    break;
  case "list":
    await list();
    break;
  case "sync":
    syncAll();
    break;
  default:
    fail(`agy-pool: unknown command ${command ?? "(none)"}.`);
}
