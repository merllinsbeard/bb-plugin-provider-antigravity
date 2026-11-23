import { copyFileSync, existsSync, mkdirSync } from "node:fs";
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
  type Account,
  type Command,
} from "./account.ts";
import { liveThreadCounts, readBindings } from "./bindings.ts";
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

async function resolve(pidArg: string | undefined): Promise<void> {
  const pid = Number(pidArg);
  if (!Number.isInteger(pid) || pid <= 0) fail("agy-pool: resolve needs the launcher pid.");
  const agy = requireAgy();
  const resolution = await resolveAccount(
    {
      paths,
      readQuota: async (account) => {
        const outcome = await probeAccount(paths, account, () => agy);
        return outcome.ok ? outcome.quota : null;
      },
    },
    {
      threadId: process.env.BB_THREAD_ID || null,
      requestedAccount: process.env.AGY_POOL_ACCOUNT || null,
      pid,
    },
  );
  if (!resolution.ok) fail(resolution.message);
  printPrefix(accountCommand(paths, resolution.account, agy, []));
}

function prepareLogin(raw: string | undefined): void {
  const name = parseAccountName(raw ?? "") ?? fail("agy-pool: usage `agy-pool login <name>`; a name is 1-16 of a-z, 0-9, _ and -.");
  const agy = requireAgy();
  const dir = name === DEFAULT_ACCOUNT ? paths.agyStateDir : path.join(paths.accountsRoot, name);
  if (name !== DEFAULT_ACCOUNT) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const settings = path.join(paths.agyStateDir, "settings.json");
    const copy = path.join(dir, "settings.json");
    if (existsSync(settings) && !existsSync(copy)) copyFileSync(settings, copy);
  }
  const account = readAccount(name, dir);
  if (!isUsable(account)) fail(`agy-pool: account "${name}" is unusable: ${account.egress.problem}`);
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

const [command, arg] = process.argv.slice(2);
switch (command) {
  case "resolve":
    await resolve(arg);
    break;
  case "prepare-login":
    prepareLogin(arg);
    break;
  case "list":
    await list();
    break;
  default:
    fail(`agy-pool: unknown command ${command ?? "(none)"}.`);
}
