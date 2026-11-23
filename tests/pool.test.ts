import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccountName } from "../src/pool/account.ts";
import { pickAccount } from "../src/pool/pick.ts";
import type { ProviderQuota } from "../src/usage/types.ts";

const launcher = fileURLToPath(new URL("../bin/agy-pool", import.meta.url));
const fakeAgy = fileURLToPath(new URL("./fixtures/home/.local/bin/agy", import.meta.url));

type Fractions = { gemini5h: number; geminiWeekly: number; other5h?: number; otherWeekly?: number };

const RESET_5H = "2026-11-23T18:00:00Z";
const RESET_WEEK = "2026-11-28T09:00:00Z";

function usageJson(f: Fractions): string {
  const bucket = (id: string, window: string, remaining_fraction: number) => ({
    id,
    name: window,
    window,
    remaining_fraction,
    reset_time: window === "5h" ? RESET_5H : RESET_WEEK,
  });
  return JSON.stringify({
    status: "SUCCESS",
    command: {
      name: "usage",
      data: {
        groups: [
          { name: "Gemini Models", buckets: [bucket("gemini-weekly", "weekly", f.geminiWeekly), bucket("gemini-5h", "5h", f.gemini5h)] },
          {
            name: "Claude and GPT models",
            buckets: [bucket("3p-weekly", "weekly", f.otherWeekly ?? 0), bucket("3p-5h", "5h", f.other5h ?? 0)],
          },
          { name: "Gemini 4 Argon", buckets: [bucket("gemini-argon-wtu-weekly", "weekly", 1)] },
        ],
      },
    },
  });
}

function quota(f: Fractions): ProviderQuota {
  const groups = (JSON.parse(usageJson(f)).command.data.groups as { name: string; buckets: any[] }[]).map((group) => ({
    name: group.name,
    buckets: group.buckets.map((bucket) => ({
      bucketId: bucket.id,
      name: bucket.name,
      window: bucket.window,
      remainingFraction: bucket.remaining_fraction,
      resetsAtIso: new Date(bucket.reset_time).toISOString(),
    })),
  }));
  return { groups };
}

const name = (raw: string) => raw as AccountName;

describe("pickAccount", () => {
  it("picks the account whose best model group has the most room", () => {
    const pick = pickAccount([
      { name: name("default"), quota: quota({ gemini5h: 0.3, geminiWeekly: 0.9 }), liveThreads: 0 },
      { name: name("alt"), quota: quota({ gemini5h: 0.9, geminiWeekly: 0.1, other5h: 0.5, otherWeekly: 0.6 }), liveThreads: 3 },
    ]);
    expect(pick).toEqual({ ok: true, account: "alt" });
  });

  it("ignores a group that has only a weekly limit", () => {
    const pick = pickAccount([
      { name: name("default"), quota: quota({ gemini5h: 0, geminiWeekly: 1 }), liveThreads: 0 },
      { name: name("alt"), quota: quota({ gemini5h: 0.05, geminiWeekly: 1 }), liveThreads: 0 },
    ]);
    expect(pick).toEqual({ ok: true, account: "alt" });
  });

  it("breaks a tie by fewer live threads", () => {
    const fresh = quota({ gemini5h: 1, geminiWeekly: 1 });
    const pick = pickAccount([
      { name: name("default"), quota: fresh, liveThreads: 2 },
      { name: name("alt"), quota: fresh, liveThreads: 1 },
    ]);
    expect(pick).toEqual({ ok: true, account: "alt" });
  });

  it("prefers an account with known room over one whose quota could not be read", () => {
    const pick = pickAccount([
      { name: name("default"), quota: null, liveThreads: 0 },
      { name: name("alt"), quota: quota({ gemini5h: 0.01, geminiWeekly: 1 }), liveThreads: 5 },
    ]);
    expect(pick).toEqual({ ok: true, account: "alt" });
  });

  it("fails with the nearest reset when every account is exhausted", () => {
    const pick = pickAccount([
      { name: name("default"), quota: quota({ gemini5h: 0.5, geminiWeekly: 0 }), liveThreads: 0 },
      { name: name("alt"), quota: quota({ gemini5h: 0, geminiWeekly: 0.5 }), liveThreads: 0 },
    ]);
    expect(pick).toEqual({
      ok: false,
      reason: "all-exhausted",
      nearestReset: { account: "alt", at: new Date(RESET_5H).toISOString() },
    });
  });
});

describe("agy-pool launcher", () => {
  let root: string;
  let home: string;
  let log: string;
  let children: ChildProcess[];

  const stateDir = () => path.join(home, ".gemini", "antigravity-cli");
  const accountDir = (account: string) => path.join(home, ".local", "share", "agy-accounts", account);
  const bindings = () => JSON.parse(readFileSync(path.join(home, ".local", "state", "agy-pool", "bindings.json"), "utf8"));

  function account(dir: string, opts: { usage?: Fractions; signedIn?: boolean; label?: string; proxy?: string }) {
    mkdirSync(dir, { recursive: true });
    if (opts.proxy !== undefined) writeFileSync(path.join(dir, "agy-pool-proxy"), `${opts.proxy}\n`, { mode: 0o600 });
    if (opts.signedIn ?? true) writeFileSync(path.join(dir, "antigravity-oauth-token"), "");
    if (opts.usage) writeFileSync(path.join(dir, "fake-usage.json"), usageJson(opts.usage));
    if (opts.label) writeFileSync(path.join(dir, "fake-name"), opts.label);
  }

  function env(extra: Record<string, string>) {
    const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("BB_") && !key.startsWith("AGY_")));
    return { ...base, HOME: home, BB_ANTIGRAVITY_EXECUTABLE: fakeAgy, AGY_FAKE_LOG: log, ...extra } as NodeJS.ProcessEnv;
  }

  function launch(extra: Record<string, string>, args: string[] = ["acp"], input = "") {
    return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(launcher, args, { env: env(extra) });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(input);
    });
  }

  function serve(threadId: string) {
    const child = spawn(launcher, ["acp"], {
      env: env({ BB_THREAD_ID: threadId, AGY_FAKE_MODE: "serve" }),
      detached: true,
    });
    children.push(child);
    return new Promise<{ child: ChildProcess; line: string }>((resolve, reject) => {
      child.stdout!.once("data", (chunk) => resolve({ child, line: String(chunk) }));
      child.once("exit", (code) => reject(new Error(`launcher exited with ${code}`)));
    });
  }

  const accountOf = (stdout: string) => /account=(\S+)/.exec(stdout)?.[1];

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "agy-pool-"));
    home = path.join(root, "home");
    log = path.join(root, "calls.log");
    children = [];
    account(stateDir(), { usage: { gemini5h: 0.2, geminiWeekly: 1 } });
  });

  afterEach(() => {
    for (const child of children) {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {}
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("gives a new thread the account with the most quota and keeps it on later starts", async () => {
    account(accountDir("alt"), { usage: { gemini5h: 0.9, geminiWeekly: 1 }, label: "alt" });
    const first = await launch({ BB_THREAD_ID: "thr_one" });
    expect(first.code).toBe(0);
    expect(accountOf(first.stdout)).toBe("alt");

    account(accountDir("alt"), { usage: { gemini5h: 0, geminiWeekly: 0 }, label: "alt" });
    const second = await launch({ BB_THREAD_ID: "thr_one" });
    expect(accountOf(second.stdout)).toBe("alt");
    expect(bindings().threads.thr_one.account).toBe("alt");
  });

  it("never picks an account that is not signed in", async () => {
    account(accountDir("empty"), { usage: { gemini5h: 1, geminiWeekly: 1 }, signedIn: false, label: "empty" });
    const run = await launch({ BB_THREAD_ID: "thr_two" });
    expect(accountOf(run.stdout)).toBe("default");
  });

  it("skips an exhausted account", async () => {
    account(stateDir(), { usage: { gemini5h: 0, geminiWeekly: 0.8, other5h: 0, otherWeekly: 1 } });
    account(accountDir("alt"), { usage: { gemini5h: 0.05, geminiWeekly: 0.05 }, label: "alt" });
    expect(accountOf((await launch({ BB_THREAD_ID: "thr_three" })).stdout)).toBe("alt");
  });

  it("refuses to start when every account is out of quota and names the nearest reset", async () => {
    account(stateDir(), { usage: { gemini5h: 0, geminiWeekly: 0.5 } });
    account(accountDir("alt"), { usage: { gemini5h: 0.5, geminiWeekly: 0 }, label: "alt" });
    const run = await launch({ BB_THREAD_ID: "thr_four" });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain(`nearest reset is ${new Date(RESET_5H).toISOString()} (account "default")`);
    expect(existsSync(path.join(home, ".local", "state", "agy-pool", "bindings.json"))).toBe(false);
  });

  it("uses the account named in AGY_POOL_ACCOUNT, or default without a thread, and records no binding", async () => {
    account(accountDir("alt"), { usage: { gemini5h: 1, geminiWeekly: 1 }, label: "alt" });
    expect(accountOf((await launch({})).stdout)).toBe("default");
    expect(accountOf((await launch({ AGY_POOL_ACCOUNT: "alt" })).stdout)).toBe("alt");
    expect(accountOf((await launch({ AGY_POOL_ACCOUNT: "alt", BB_THREAD_ID: "thr_manual" })).stdout)).toBe("alt");
    expect(existsSync(path.join(home, ".local", "state", "agy-pool", "bindings.json"))).toBe(false);
  });

  it("passes arguments, stdin and the exit code through to agy", async () => {
    account(accountDir("alt"), { usage: { gemini5h: 1, geminiWeekly: 1 }, label: "alt" });
    const run = await launch({ BB_THREAD_ID: "thr_five", AGY_FAKE_EXIT: "7" }, ["acp", "--dangerously-skip-permissions"], "hello over stdio\n");
    expect(run.code).toBe(7);
    expect(run.stdout).toMatch(/account=alt pid=\d+ args=acp --dangerously-skip-permissions\nhello over stdio\n$/);
  });

  it("spreads threads that start together across accounts with equal quota", async () => {
    account(stateDir(), { usage: { gemini5h: 1, geminiWeekly: 1 } });
    account(accountDir("alt"), { usage: { gemini5h: 1, geminiWeekly: 1 }, label: "alt" });
    const [a, b] = await Promise.all([serve("thr_a"), serve("thr_b")]);
    expect([accountOf(a.line), accountOf(b.line)].sort()).toEqual(["alt", "default"]);
  });

  it("lets agy inside the bind shut down on the SIGTERM sequence BB sends", async () => {
    account(stateDir(), { usage: { gemini5h: 0.1, geminiWeekly: 1 } });
    account(accountDir("alt"), { usage: { gemini5h: 1, geminiWeekly: 1 }, label: "alt" });
    const { child, line } = await serve("thr_term");
    expect(accountOf(line)).toBe("alt");
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await exited;
    process.kill(-child.pid!, "SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(readFileSync(log, "utf8")).toContain("term alt");
  });

  it("lists every account with its sign-in state and quota", async () => {
    account(accountDir("alt"), { usage: { gemini5h: 1, geminiWeekly: 1 }, label: "alt" });
    account(accountDir("empty"), { signedIn: false });
    await launch({ BB_THREAD_ID: "thr_six" });
    const run = await launch({}, ["list"]);
    const listed = JSON.parse(run.stdout).accounts;
    expect(listed.map((a: { name: string; authenticated: boolean; boundThreads: number }) => [a.name, a.authenticated, a.boundThreads])).toEqual([
      ["default", true, 0],
      ["alt", true, 1],
      ["empty", false, 0],
    ]);
    expect(listed[1].quota.map((w: { label: string }) => w.label)).toContain("5h · Gemini");
    expect(listed[2].quota).toBeNull();
  });
  const PROXY = "http://pool-user:s3cret@127.0.0.1:3128";
  const NO_PROXY = "localhost,127.0.0.1,::1,100.64.0.0/10,.ts.net";
  const proxied = (url: string) => `|account=alt|https_proxy=${url}|http_proxy=${url}|no_proxy=${NO_PROXY}`;
  const usageCalls = () => readFileSync(log, "utf8").trim().split("\n").filter((line) => line.startsWith("-p /usage"));

  it("probes and launches a proxied account through its proxy and leaves a direct account direct", async () => {
    account(accountDir("alt"), { usage: { gemini5h: 0.9, geminiWeekly: 1 }, label: "alt", proxy: PROXY });
    const run = await launch({ BB_THREAD_ID: "thr_proxy" });
    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(new RegExp(`^account=alt pid=\\d+ args=acp\\|account=alt\\|https_proxy=${PROXY}\\|`));
    expect(run.stdout).toContain(proxied(PROXY));
    expect(usageCalls().sort()).toEqual([
      "-p /usage --output-format json --print-timeout 15s|marker=",
      `-p /usage --output-format json --print-timeout 15s|marker=${proxied(PROXY)}`,
    ]);
  });

  it("keeps the proxy URL out of the launched process's command line", async () => {
    account(stateDir(), { usage: { gemini5h: 0.1, geminiWeekly: 1 } });
    account(accountDir("alt"), { usage: { gemini5h: 1, geminiWeekly: 1 }, label: "alt", proxy: PROXY });
    const { child, line } = await serve("thr_argv");
    expect(line).toContain(proxied(PROXY));
    const argv = readFileSync(`/proc/${child.pid}/cmdline`, "utf8");
    expect(argv).toContain("bwrap");
    expect(argv).not.toContain("s3cret");
  });

  it("never picks or launches an account whose proxy file is malformed", async () => {
    account(accountDir("alt"), { usage: { gemini5h: 1, geminiWeekly: 1 }, label: "alt", proxy: "ftp://127.0.0.1:21" });
    expect(accountOf((await launch({ BB_THREAD_ID: "thr_bad" })).stdout)).toBe("default");

    const forced = await launch({ AGY_POOL_ACCOUNT: "alt" });
    expect(forced.code).toBe(1);
    expect(forced.stdout).toBe("");
    expect(forced.stderr).toContain('account "alt" is unusable');
    expect(usageCalls().some((line) => line.includes("account=alt"))).toBe(false);
  });

  it("refuses to start a thread bound to an account whose proxy file broke, instead of going direct", async () => {
    account(accountDir("alt"), { usage: { gemini5h: 1, geminiWeekly: 1 }, label: "alt", proxy: PROXY });
    expect(accountOf((await launch({ BB_THREAD_ID: "thr_bound" })).stdout)).toBe("alt");
    writeFileSync(path.join(accountDir("alt"), "agy-pool-proxy"), "not a url\n");
    const run = await launch({ BB_THREAD_ID: "thr_bound" });
    expect(run.code).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("agy-pool-proxy");
  });

  it("lists each account's egress without the proxy credentials", async () => {
    account(accountDir("alt"), { usage: { gemini5h: 1, geminiWeekly: 1 }, label: "alt", proxy: PROXY });
    account(accountDir("bad"), { usage: { gemini5h: 1, geminiWeekly: 1 }, label: "bad", proxy: "http://u:hidden@" });
    const run = await launch({}, ["list"]);
    expect(run.stdout).not.toContain("s3cret");
    expect(run.stdout).not.toContain("hidden");
    const listed = JSON.parse(run.stdout).accounts;
    expect(listed.map((a: { name: string; egress: string }) => [a.name, a.egress])).toEqual([
      ["default", "direct"],
      ["alt", "proxy 127.0.0.1:3128"],
      ["bad", "unusable"],
    ]);
    expect(listed[2].quotaStatus.message).toContain("agy-pool-proxy");
  });

  describe("login with a proxy", () => {
    let server: ReturnType<typeof createServer>;
    let seen: IncomingMessage[];

    beforeEach(async () => {
      seen = [];
      server = createServer((req, res) => {
        seen.push(req);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ status: "success", countryCode: "NL", query: "203.0.113.7" }));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    });

    afterEach(() => server.close());

    it("checks the exit IP through the saved proxy, then signs in through it", async () => {
      const url = `http://pool-user:s3cret@127.0.0.1:${(server.address() as AddressInfo).port}`;
      const run = await launch({}, ["login", "fresh", "--proxy", url]);
      expect(run.code).toBe(0);
      expect(run.stderr).toContain("as 203.0.113.7 (NL)");
      expect(run.stdout).toMatch(/args=acp --login\|/);
      expect(run.stdout).toContain(`https_proxy=${url}`);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.headers["proxy-authorization"]).toBe(`Basic ${Buffer.from("pool-user:s3cret").toString("base64")}`);
      const file = path.join(accountDir("fresh"), "agy-pool-proxy");
      expect(readFileSync(file, "utf8").trim()).toBe(url);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    });

    it("does not start the sign-in when the proxy does not answer", async () => {
      const port = (server.address() as AddressInfo).port;
      await new Promise((resolve) => server.close(resolve));
      const run = await launch({}, ["login", "fresh", "--proxy", `http://127.0.0.1:${port}`]);
      expect(run.code).toBe(1);
      expect(run.stdout).toBe("");
      expect(run.stderr).toContain(`proxy 127.0.0.1:${port} for account "fresh" does not work`);
      expect(existsSync(log) && readFileSync(log, "utf8").includes("--login")).toBe(false);
    });
  });
});
