import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HOST_MACHINE_ID,
  MACHINE_ID_FILE,
  accountCommand,
  ensureMachineId,
  poolPaths,
  type AccountName,
  type UsableAccount,
} from "../src/pool/account.ts";
import { clearExhausted, isMarkStale } from "../src/pool/exhaustion.ts";
import { modelFamily } from "../src/pool/family.ts";
import { pickAccount } from "../src/pool/pick.ts";
import type { ProviderQuota } from "../src/usage/types.ts";

const launcher = fileURLToPath(new URL("../bin/agy-pool", import.meta.url));
const poolCli = fileURLToPath(new URL("../src/pool/cli.ts", import.meta.url));
const fakeAgy = fileURLToPath(new URL("./fixtures/home/.local/bin/agy", import.meta.url));

type Fractions = {
  gemini5h: number;
  geminiWeekly: number;
  other5h?: number;
  otherWeekly?: number;
  /** Live reset times of the Gemini windows; the fixed RESET_5H and RESET_WEEK otherwise. */
  geminiResets?: { "5h"?: string; weekly?: string };
};

// Relative to the run, so the weekly window is never "expiring soon" unless a test says so.
const RESET_5H = new Date(Date.now() + 3 * 3600_000).toISOString();
const RESET_WEEK = new Date(Date.now() + 6 * 24 * 3600_000).toISOString();

function usageJson(f: Fractions): string {
  const bucket = (id: string, window: string, remaining_fraction: number) => ({
    id,
    name: window,
    window,
    remaining_fraction,
    reset_time:
      (id.startsWith("gemini-") ? f.geminiResets?.[window as "5h" | "weekly"] : undefined) ?? (window === "5h" ? RESET_5H : RESET_WEEK),
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
  it("prioritizes weekly quota over untouched 5h windows", () => {
    const pick = pickAccount([
      { name: name("default"), quota: quota({ gemini5h: 0.2, geminiWeekly: 0.9 }), liveThreads: 0 },
      { name: name("alt"), quota: quota({ gemini5h: 1, geminiWeekly: 0.5 }), liveThreads: 0 },
    ]);
    expect(pick).toEqual({ ok: true, account: "default" });
  });

  it("drains an account with an already-active 5h window instead of spreading evenly across untouched accounts", () => {
    const pick = pickAccount(
      [
        { name: name("default"), quota: quota({ gemini5h: 0.75, geminiWeekly: 0.95 }), liveThreads: 1 },
        { name: name("acc2"), quota: quota({ gemini5h: 1, geminiWeekly: 1 }), liveThreads: 0 },
        { name: name("acc3"), quota: quota({ gemini5h: 1, geminiWeekly: 1 }), liveThreads: 0 },
      ],
      "gemini",
    );
    expect(pick).toEqual({ ok: true, account: "default" });
  });

  it("finishes the more-drained active 5h window first when two active accounts are close on weekly", () => {
    const pick = pickAccount(
      [
        { name: name("default"), quota: quota({ gemini5h: 0.3, geminiWeekly: 0.92 }), liveThreads: 0 },
        { name: name("acc2"), quota: quota({ gemini5h: 0.7, geminiWeekly: 0.95 }), liveThreads: 0 },
      ],
      "gemini",
    );
    expect(pick).toEqual({ ok: true, account: "default" });
  });

  it("switches to a fuller weekly account once the active account falls more than 20% behind on weekly", () => {
    const pick = pickAccount([
      { name: name("default"), quota: quota({ gemini5h: 0.48, geminiWeekly: 0.38, other5h: 1, otherWeekly: 1 }), liveThreads: 0 },
      { name: name("alt"), quota: quota({ gemini5h: 1, geminiWeekly: 1, other5h: 1, otherWeekly: 1 }), liveThreads: 0 },
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

describe("pickAccount scheduling", () => {
  const now = new Date("2026-11-26T12:00:00Z");
  const inHours = (hours: number) => new Date(now.getTime() + hours * 3600_000).toISOString();
  const resetting = (hours: number, f: Omit<Fractions, "geminiResets">) => quota({ ...f, geminiResets: { weekly: inHours(hours) } });

  it("burns a weekly window that resets within 48h before a fuller account resetting in six days", () => {
    const pick = pickAccount(
      [
        { name: name("full"), quota: resetting(144, { gemini5h: 1, geminiWeekly: 1 }), liveThreads: 0 },
        { name: name("expiring"), quota: resetting(20, { gemini5h: 1, geminiWeekly: 0.3 }), liveThreads: 0 },
      ],
      "gemini",
      now,
    );
    expect(pick).toEqual({ ok: true, account: "expiring" });
  });

  it("takes the earlier of two expiring weekly windows", () => {
    const pick = pickAccount(
      [
        { name: name("later"), quota: resetting(40, { gemini5h: 1, geminiWeekly: 0.9 }), liveThreads: 0 },
        { name: name("sooner"), quota: resetting(10, { gemini5h: 1, geminiWeekly: 0.2 }), liveThreads: 0 },
      ],
      "gemini",
      now,
    );
    expect(pick).toEqual({ ok: true, account: "sooner" });
  });

  it("does not chase an expiring window with 5% or less left, a reset already past, or an unset epoch reset", () => {
    for (const [hours, weekly] of [
      [20, 0.05],
      [-1, 0.5],
    ] as const) {
      const pick = pickAccount(
        [
          { name: name("full"), quota: resetting(144, { gemini5h: 1, geminiWeekly: 1 }), liveThreads: 0 },
          { name: name("other"), quota: resetting(hours, { gemini5h: 1, geminiWeekly: weekly }), liveThreads: 0 },
        ],
        "gemini",
        now,
      );
      expect(pick).toEqual({ ok: true, account: "full" });
    }
    const epoch = quota({ gemini5h: 1, geminiWeekly: 0.5, geminiResets: { weekly: "1970-01-01T00:00:00Z" } });
    expect(
      pickAccount(
        [
          { name: name("full"), quota: resetting(144, { gemini5h: 1, geminiWeekly: 1 }), liveThreads: 0 },
          { name: name("epoch"), quota: epoch, liveThreads: 0 },
        ],
        "gemini",
        now,
      ),
    ).toEqual({ ok: true, account: "full" });
  });

  it("opens a fresh Gemini window on an account whose Claude/GPT room is gone before one that still serves both", () => {
    const geminiOnly = resetting(144, { gemini5h: 1, geminiWeekly: 1, other5h: 0, otherWeekly: 0 });
    const both = resetting(144, { gemini5h: 1, geminiWeekly: 1, other5h: 1, otherWeekly: 1 });
    for (const order of [
      ["acc5", "acc3"],
      ["acc3", "acc5"],
    ]) {
      const candidates = order.map((raw) => ({ name: name(raw), quota: raw === "acc3" ? geminiOnly : both, liveThreads: 0 }));
      expect(pickAccount(candidates, "gemini", now)).toEqual({ ok: true, account: "acc3" });
    }
    // Claude/GPT goes where that family still has room.
    expect(
      pickAccount(
        [
          { name: name("acc3"), quota: geminiOnly, liveThreads: 0 },
          { name: name("acc5"), quota: both, liveThreads: 0 },
        ],
        "3p",
        now,
      ),
    ).toEqual({ ok: true, account: "acc5" });
  });

  it("keeps draining an active 5h burst on a dual account over a fresh single-family one", () => {
    const pick = pickAccount(
      [
        { name: name("acc3"), quota: resetting(144, { gemini5h: 1, geminiWeekly: 1, other5h: 0, otherWeekly: 0 }), liveThreads: 0 },
        { name: name("acc5"), quota: resetting(144, { gemini5h: 0.6, geminiWeekly: 0.9, other5h: 1, otherWeekly: 1 }), liveThreads: 1 },
      ],
      "gemini",
      now,
    );
    expect(pick).toEqual({ ok: true, account: "acc5" });
  });
});

describe("modelFamily", () => {
  it("files each agy model under the quota group that meters it", () => {
    expect(["gemini-4-neon-high", "gemini-4-hydrogen-low", "gemini-3.8-flash-medium", "gemini-pro-orchestrator-neon"].map(modelFamily)).toEqual([
      "gemini",
      "gemini",
      "gemini",
      "gemini",
    ]);
    expect(["claude-opus-5-5-medium", "claude-sonnet-5-5-high", "gpt-oss-120b-medium"].map(modelFamily)).toEqual(["3p", "3p", "3p"]);
    expect(["gemini-4-argon-high", "gemini-pro-orchestrator-argon"].map(modelFamily)).toEqual(["argon", "argon"]);
  });
});

describe("pickAccount for a known model family", () => {
  // The 24.11 live state: Claude/GPT 5h spent everywhere, Gemini 5h at 15-18% left.
  const spent3p = (gemini5h: number) => quota({ gemini5h, geminiWeekly: 0.78, other5h: 0, otherWeekly: 0.5 });

  it("starts a Gemini session on an account whose Claude/GPT window is spent", () => {
    const pick = pickAccount(
      [
        { name: name("default"), quota: spent3p(0.18), liveThreads: 0 },
        { name: name("acc3"), quota: spent3p(0.15), liveThreads: 0 },
      ],
      "gemini",
    );
    expect(pick).toEqual({ ok: true, account: "acc3" });
  });

  it("refuses Claude/GPT with that family's reset when only Gemini has room", () => {
    const pick = pickAccount([{ name: name("default"), quota: spent3p(0.18), liveThreads: 0 }], "3p");
    expect(pick).toEqual({ ok: false, reason: "all-exhausted", nearestReset: { account: "default", at: new Date(RESET_5H).toISOString() } });
  });

  it("sends Claude/GPT to the account with Claude/GPT room even when another has more Gemini", () => {
    const pick = pickAccount(
      [
        { name: name("default"), quota: spent3p(1), liveThreads: 0 },
        { name: name("alt"), quota: quota({ gemini5h: 0.1, geminiWeekly: 0.5, other5h: 0.3, otherWeekly: 0.9 }), liveThreads: 4 },
      ],
      "3p",
    );
    expect(pick).toEqual({ ok: true, account: "alt" });
  });
});

describe("exhaustion marks", () => {
  const at = (ms: number) => new Date(Date.parse("2026-11-26T12:00:00Z") + ms).toISOString();
  const HOUR = 3600 * 1000;
  const live = (gemini5h: number, resets: { "5h": string; weekly: string }) =>
    quota({ gemini5h, geminiWeekly: 1, geminiResets: resets });

  it("keeps a mark while a live window of its family still resets at the marked time, even with a sliver left", () => {
    // 26.11 acc2: agy refused Gemini at 99.6% used; the mark landed 0.3s off the live 5h reset.
    const mark = at(5 * HOUR);
    expect(isMarkStale(mark, live(0.004, { "5h": at(5 * HOUR - 334), weekly: at(100 * HOUR) }), "gemini")).toBe(false);
  });

  it("calls a mark stale once Google reset the window early and every live reset moved days away", () => {
    // 26.11 default/acc3/acc5: marks for 30.11, live weekly reset 03.12 with the window full again.
    expect(isMarkStale(at(4 * 24 * HOUR), live(1, { "5h": at(5 * HOUR), weekly: at(7 * 24 * HOUR) }), "gemini")).toBe(true);
  });

  it("keeps a mark when live quota has no room or no windows for the family", () => {
    const resets = { "5h": at(5 * HOUR), weekly: at(7 * 24 * HOUR) };
    expect(isMarkStale(at(4 * 24 * HOUR), live(0, resets), "gemini")).toBe(false);
    expect(isMarkStale(at(4 * 24 * HOUR), quota({ gemini5h: 1, geminiWeekly: 1 }), "argon")).toBe(false);
  });

  it("clears only the named account and family pairs", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agy-marks-"));
    const file = path.join(dir, "exhausted.json");
    const marks = { acc2: { gemini: at(HOUR), "3p": at(2 * HOUR) }, acc3: { gemini: at(3 * HOUR) } };
    writeFileSync(file, JSON.stringify({ version: 2, accounts: marks }));
    try {
      clearExhausted(file, [
        { account: name("acc2"), family: "gemini" },
        { account: name("acc5"), family: "gemini" },
      ]);
      expect(JSON.parse(readFileSync(file, "utf8")).accounts).toEqual({ acc2: { "3p": at(2 * HOUR) }, acc3: { gemini: at(3 * HOUR) } });
      clearExhausted(file, [{ account: name("acc3"), family: "gemini" }]);
      expect(JSON.parse(readFileSync(file, "utf8")).accounts).toEqual({ acc2: { "3p": at(2 * HOUR) } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  function account(dir: string, opts: { usage?: Fractions; signedIn?: boolean; label?: string; proxy?: string; print?: "quota" | "throttle" }) {
    mkdirSync(dir, { recursive: true });
    if (opts.print) writeFileSync(path.join(dir, "fake-print"), opts.print);
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
    account(stateDir(), { usage: { gemini5h: 0.2, geminiWeekly: 0.2 } });
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

  describe("stale exhaustion marks", () => {
    const HOUR = 3600 * 1000;
    const from = (ms: number) => new Date(Date.now() + ms).toISOString();
    const marksFile = () => path.join(home, ".local", "state", "agy-pool", "exhausted.json");
    const writeMarks = (accounts: Record<string, Record<string, string>>) => {
      mkdirSync(path.dirname(marksFile()), { recursive: true });
      writeFileSync(marksFile(), JSON.stringify({ version: 2, accounts }));
    };
    const marks = () => JSON.parse(readFileSync(marksFile(), "utf8")).accounts;
    // What the relay runs when a Gemini prompt needs an account: `cli.ts resolve <pid> <refused|-> <reset ms> gemini`.
    const resolveGemini = (refused = "-") =>
      new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
        const child = spawn(process.execPath, [poolCli, "resolve", "4242", refused, "0", "gemini"], { env: env({ BB_THREAD_ID: "thr_marks" }) });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.on("close", (code) => resolve({ code, stdout, stderr }));
      });
    const resolvedAccount = (stdout: string) => /AGY_POOL_RESOLVED=(\S+)/.exec(stdout)?.[1];
    // A Gemini window Google reset early: full again, every live reset days away from the old mark.
    const resetEarly = { gemini5h: 1, geminiWeekly: 1, geminiResets: { "5h": from(5 * HOUR), weekly: from(7 * 24 * HOUR) } };

    it("clears a mark the live quota outlived and starts on that account, keeping its other marks", async () => {
      const refusal = from(2 * HOUR);
      account(stateDir(), { usage: { gemini5h: 0.004, geminiWeekly: 0.5, geminiResets: { "5h": refusal } } });
      account(accountDir("acc3"), { usage: resetEarly, label: "acc3" });
      const claudeRefusal = from(HOUR);
      writeMarks({ default: { gemini: refusal }, acc3: { gemini: from(4 * 24 * HOUR), "3p": claudeRefusal } });

      const run = await resolveGemini();
      expect(run.code).toBe(0);
      expect(resolvedAccount(run.stdout)).toBe("acc3");
      expect(marks()).toEqual({ default: { gemini: refusal }, acc3: { "3p": claudeRefusal } });
    });

    it("keeps a mark whose window still resets at the marked time, though that window shows 0.4% left", async () => {
      const refusal = from(2 * HOUR);
      account(stateDir(), { usage: { gemini5h: 0.004, geminiWeekly: 0.5, geminiResets: { "5h": from(2 * HOUR - 700) } } });
      writeMarks({ default: { gemini: refusal } });

      const run = await resolveGemini();
      expect(run.code).toBe(1);
      expect(run.stderr).toContain(`every Antigravity account is out of Gemini quota. The nearest reset is ${refusal} (account "default")`);
      expect(marks()).toEqual({ default: { gemini: refusal } });
    });

    it("never hands a prompt back to the account that just refused it", async () => {
      account(stateDir(), { usage: resetEarly });
      const stale = from(4 * 24 * HOUR);
      writeMarks({ default: { gemini: stale } });

      const run = await resolveGemini("default");
      expect(run.code).toBe(1);
      expect(marks()).toEqual({ default: { gemini: stale } });
    });

    it("recovers a stale-marked account when every unmarked account turns out to be out live", async () => {
      account(stateDir(), { usage: { gemini5h: 0, geminiWeekly: 0.5 } });
      account(accountDir("acc2"), { usage: { gemini5h: 0.3, geminiWeekly: 0 }, label: "acc2" });
      account(accountDir("acc5"), { usage: resetEarly, label: "acc5" });
      writeMarks({ acc5: { gemini: from(5 * 24 * HOUR) } });

      const run = await resolveGemini();
      expect(run.code).toBe(0);
      expect(resolvedAccount(run.stdout)).toBe("acc5");
      expect(marks()).toEqual({});
    });
  });

  describe("one-shot print runs", () => {
    const exhausted = () => JSON.parse(readFileSync(path.join(home, ".local", "state", "agy-pool", "exhausted.json"), "utf8"));
    const print = (model: string) => ["-p", "draw an apple", "--model", model, "--output-format", "json"];

    it("runs on the account with the most room for the model's family and binds no thread", async () => {
      account(accountDir("alt"), { usage: { gemini5h: 1, geminiWeekly: 1 }, label: "alt" });
      const run = await launch({ BB_THREAD_ID: "thr_caller" }, print("gemini-3.8-flash-low"));
      expect(run.code).toBe(0);
      expect(JSON.parse(run.stdout).response).toBe("ran on alt");
      expect(existsSync(path.join(home, ".local", "state", "agy-pool", "bindings.json"))).toBe(false);
    });

    it("picks by the family of --model", async () => {
      account(stateDir(), { usage: { gemini5h: 0.1, geminiWeekly: 0.1, other5h: 0.9, otherWeekly: 0.9 } });
      account(accountDir("alt"), { usage: { gemini5h: 1, geminiWeekly: 1, other5h: 0, otherWeekly: 0.1 }, label: "alt" });
      const run = await launch({}, print("claude-sonnet-5-5-low"));
      expect(JSON.parse(run.stdout).response).toBe("ran on default");
    });

    it("runs a refused prompt again on the next account and marks the refusal until agy's reset", async () => {
      account(accountDir("alt"), { usage: { gemini5h: 1, geminiWeekly: 1 }, label: "alt", print: "quota" });
      const before = Date.now();
      const run = await launch({}, print("gemini-3.8-flash-low"));
      expect(run.code).toBe(0);
      expect(run.stdout.trim().split("\n")).toHaveLength(1);
      expect(JSON.parse(run.stdout).response).toBe("ran on default");
      expect(run.stderr).toContain('agy-pool: account "alt" is out of Gemini quota; running again on another account.');
      const until = Date.parse(exhausted().accounts.alt.gemini);
      expect(until - before).toBeGreaterThanOrEqual(2 * 3600 * 1000 - 1000);
      expect(until - before).toBeLessThan(2 * 3600 * 1000 + 60 * 1000);
    });

    it("does not move a run forced onto an account with AGY_POOL_ACCOUNT", async () => {
      account(accountDir("alt"), { usage: { gemini5h: 1, geminiWeekly: 1 }, label: "alt", print: "quota" });
      const run = await launch({ AGY_POOL_ACCOUNT: "alt" }, print("gemini-3.8-flash-low"));
      expect(run.code).toBe(3);
      expect(JSON.parse(run.stdout).status).toBe("ERROR");
      expect(run.stderr).not.toContain("running again");
    });

    it("moves a throttled run without marking the account", async () => {
      account(accountDir("alt"), { usage: { gemini5h: 1, geminiWeekly: 1 }, label: "alt", print: "throttle" });
      const run = await launch({}, print("gemini-3.8-flash-low"));
      expect(run.code).toBe(0);
      expect(JSON.parse(run.stdout).response).toBe("ran on default");
      expect(existsSync(path.join(home, ".local", "state", "agy-pool", "exhausted.json"))).toBe(false);
    });

    it("gives a stream-json run one attempt with agy's own output", async () => {
      account(accountDir("alt"), { usage: { gemini5h: 1, geminiWeekly: 1 }, label: "alt", print: "quota" });
      const run = await launch({}, ["-p", "draw an apple", "--model", "gemini-3.8-flash-low", "--output-format", "stream-json"]);
      expect(run.code).toBe(3);
      expect(JSON.parse(run.stdout).status).toBe("ERROR");
      expect(run.stderr).not.toContain("running again");
    });

    it("runs a non-print call once with its exit code and binds no thread", async () => {
      account(accountDir("alt"), { usage: { gemini5h: 1, geminiWeekly: 1 }, label: "alt" });
      const run = await launch({ BB_THREAD_ID: "thr_caller" }, ["--version"]);
      expect(run.code).toBe(0);
      expect(run.stdout.trim()).toBe("1.5.15");
      expect(existsSync(path.join(home, ".local", "state", "agy-pool", "bindings.json"))).toBe(false);
    });

    it("hands back agy's refusal and the pool's reason when every account refuses", async () => {
      account(stateDir(), { usage: { gemini5h: 0.5, geminiWeekly: 0.5 }, print: "quota" });
      account(accountDir("alt"), { usage: { gemini5h: 1, geminiWeekly: 1 }, label: "alt", print: "quota" });
      const run = await launch({}, print("gemini-3.8-flash-low"));
      expect(run.code).toBe(3);
      expect(JSON.parse(run.stdout).status).toBe("ERROR");
      expect(run.stderr).toMatch(/every Antigravity account is out of Gemini quota\. The nearest reset is \S+ \(account "(alt|default)"\)/);
      expect(Object.keys(exhausted().accounts).sort()).toEqual(["alt", "default"]);
    });
  });

  it("passes arguments, stdin and the exit code through to agy", async () => {
    account(accountDir("alt"), { usage: { gemini5h: 1, geminiWeekly: 1 }, label: "alt" });
    const run = await launch({ BB_THREAD_ID: "thr_five", AGY_FAKE_EXIT: "7" }, ["acp", "--dangerously-skip-permissions"], "hello over stdio\n");
    expect(run.code).toBe(7);
    expect(run.stdout).toMatch(/account=alt pid=\d+ machine=[0-9a-f]+ args=acp --dangerously-skip-permissions\nhello over stdio\n$/);
  });

  it("binds an ACP thread even when the caller's environment carries the one-shot flag", async () => {
    account(accountDir("alt"), { usage: { gemini5h: 1, geminiWeekly: 1 }, label: "alt" });
    const run = await launch({ BB_THREAD_ID: "thr_leak", AGY_POOL_ONE_SHOT: "1" }, ["acp"], "");
    expect(run.code).toBe(0);
    expect(readFileSync(path.join(home, ".local", "state", "agy-pool", "bindings.json"), "utf8")).toContain("thr_leak");
  });

  it("spreads threads that start together across accounts with equal quota", async () => {
    account(stateDir(), { usage: { gemini5h: 1, geminiWeekly: 1 } });
    account(accountDir("alt"), { usage: { gemini5h: 1, geminiWeekly: 1 }, label: "alt" });
    const [a, b] = await Promise.all([serve("thr_a"), serve("thr_b")]);
    expect([accountOf(a.line), accountOf(b.line)].sort()).toEqual(["alt", "default"]);
  });

  it("lets agy inside the bind shut down on the SIGTERM sequence BB sends", async () => {
    account(stateDir(), { usage: { gemini5h: 0.1, geminiWeekly: 0.2 } });
    account(accountDir("alt"), { usage: { gemini5h: 1, geminiWeekly: 1 }, label: "alt" });
    const { child, line } = await serve("thr_term");
    expect(accountOf(line)).toBe("alt");
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await exited;
    try {
      process.kill(-child.pid!, "SIGTERM");
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(readFileSync(log, "utf8")).toContain("term alt");
  });

  describe("disable and enable", () => {
    const marker = () => path.join(accountDir("alt"), "agy-pool-disabled");

    it("takes an account out of picking until it is enabled again, and shows it in the list", async () => {
      account(accountDir("alt"), { usage: { gemini5h: 1, geminiWeekly: 1 }, label: "alt" });
      const disabled = await launch({}, ["disable", "alt", "ban", "risk"]);
      expect(disabled.code).toBe(0);
      expect(JSON.parse(disabled.stdout)).toEqual({ account: "alt", disabled: true, disabledReason: "ban risk" });
      expect(statSync(marker()).mode & 0o777).toBe(0o600);

      expect(accountOf((await launch({ BB_THREAD_ID: "thr_off" })).stdout)).toBe("default");
      expect(accountOf((await launch({ BB_THREAD_ID: "thr_pinned", AGY_POOL_ACCOUNT: "alt" })).stdout)).toBe("alt");
      const listed = JSON.parse((await launch({}, ["list"])).stdout).accounts;
      expect(listed.map((a: { name: string; disabled: boolean; disabledReason?: string }) => [a.name, a.disabled, a.disabledReason])).toEqual([
        ["default", false, undefined],
        ["alt", true, "ban risk"],
      ]);

      for (let i = 0; i < 2; i++) {
        const enabled = await launch({}, ["enable", "alt"]);
        expect(enabled.code).toBe(0);
        expect(JSON.parse(enabled.stdout)).toEqual({ account: "alt", disabled: false });
      }
      expect(existsSync(marker())).toBe(false);
      expect(accountOf((await launch({ BB_THREAD_ID: "thr_on" })).stdout)).toBe("alt");
    });

    it("moves a thread bound to an account that was disabled since", async () => {
      account(accountDir("alt"), { usage: { gemini5h: 1, geminiWeekly: 1 }, label: "alt" });
      expect(accountOf((await launch({ BB_THREAD_ID: "thr_moved" })).stdout)).toBe("alt");
      await launch({}, ["disable", "alt"]);
      expect(accountOf((await launch({ BB_THREAD_ID: "thr_moved" })).stdout)).toBe("default");
      expect(bindings().threads.thr_moved.account).toBe("default");
    });

    it("rejects an unknown account and names `agy-pool enable` when every signed-in account is disabled", async () => {
      const unknown = await launch({}, ["disable", "nobody"]);
      expect(unknown.code).toBe(1);
      expect(unknown.stderr).toContain('no account named "nobody"');

      await launch({}, ["disable", "default"]);
      const run = await launch({ BB_THREAD_ID: "thr_none" });
      expect(run.code).toBe(1);
      expect(run.stderr).toContain("every signed-in Antigravity account is disabled (default). Run `agy-pool enable <name>`.");
    });
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
  it("probes every account at once, so the list takes about one probe's time and keeps account order", async () => {
    for (const name of ["a1", "a2", "a3"]) account(accountDir(name), { usage: { gemini5h: 1, geminiWeekly: 1 }, label: name });
    const delaySeconds = 2;
    const started = Date.now();
    const run = await launch({ AGY_FAKE_DELAY: String(delaySeconds) }, ["list"]);
    const elapsed = Date.now() - started;
    expect(run.code).toBe(0);
    const listed = JSON.parse(run.stdout).accounts;
    expect(listed.map((a: { name: string }) => a.name)).toEqual(["default", "a1", "a2", "a3"]);
    for (const entry of listed) expect(entry.quota).not.toBeNull();
    // Four probes one after another would take at least 8 s.
    expect(elapsed).toBeLessThan(2.5 * delaySeconds * 1000);
  });

  describe("machine id isolation", () => {
    const hostId = () => readFileSync(HOST_MACHINE_ID, "utf8").trim();
    const machineOf = (stdout: string) => /machine=(\S*)/.exec(stdout)?.[1];

    it("runs an added account with its own /etc/machine-id and the default account with the host's", async () => {
      account(accountDir("alt"), { usage: { gemini5h: 1, geminiWeekly: 1 }, label: "alt" });
      const alt = await launch({ AGY_POOL_ACCOUNT: "alt" });
      expect(accountOf(alt.stdout)).toBe("alt");
      const own = readFileSync(path.join(accountDir("alt"), MACHINE_ID_FILE), "utf8");
      expect(own).toMatch(/^[0-9a-f]{32}\n$/);
      expect(machineOf(alt.stdout)).toBe(own.trim());
      expect(machineOf(alt.stdout)).not.toBe(hostId());

      const again = await launch({ AGY_POOL_ACCOUNT: "alt" });
      expect(machineOf(again.stdout)).toBe(own.trim());

      const host = await launch({ AGY_POOL_ACCOUNT: "default" });
      expect(machineOf(host.stdout)).toBe(hostId());
      expect(existsSync(path.join(stateDir(), MACHINE_ID_FILE))).toBe(false);
    });

    it("gives each added account a different id on sync", async () => {
      account(accountDir("acc2"), { usage: { gemini5h: 1, geminiWeekly: 1 } });
      account(accountDir("acc3"), { usage: { gemini5h: 1, geminiWeekly: 1 } });
      expect((await launch({}, ["sync"])).code).toBe(0);
      const ids = ["acc2", "acc3"].map((name) => readFileSync(path.join(accountDir(name), MACHINE_ID_FILE), "utf8"));
      expect(ids[0]).not.toBe(ids[1]);
      for (const name of ["acc2", "acc3"]) expect(statSync(path.join(accountDir(name), MACHINE_ID_FILE)).mode & 0o777).toBe(0o600);
    });
  });

  const PROXY = "http://pool-user:s3cret@127.0.0.1:3128";
  const NO_PROXY = "localhost,127.0.0.1,::1,100.64.0.0/10,.ts.net";
  const proxied = (url: string) => `|account=alt|https_proxy=${url}|http_proxy=${url}|no_proxy=${NO_PROXY}`;
  const usageCalls = () => readFileSync(log, "utf8").trim().split("\n").filter((line) => line.startsWith("-p /usage"));

  it("probes and launches a proxied account through its proxy and leaves a direct account direct", async () => {
    account(accountDir("alt"), { usage: { gemini5h: 0.9, geminiWeekly: 1 }, label: "alt", proxy: PROXY });
    const run = await launch({ BB_THREAD_ID: "thr_proxy" });
    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(new RegExp(`^account=alt pid=\\d+ machine=[0-9a-f]+ args=acp\\|account=alt\\|https_proxy=${PROXY}\\|`));
    expect(run.stdout).toContain(proxied(PROXY));
    expect(usageCalls().sort()).toEqual([
      "-p /usage --output-format json --print-timeout 15s|marker=",
      `-p /usage --output-format json --print-timeout 15s|marker=${proxied(PROXY)}`,
    ]);
  });

  it("keeps the proxy URL out of the launched process's command line", async () => {
    account(stateDir(), { usage: { gemini5h: 0.1, geminiWeekly: 0.2 } });
    account(accountDir("alt"), { usage: { gemini5h: 1, geminiWeekly: 1 }, label: "alt", proxy: PROXY });
    const { child, line } = await serve("thr_argv");
    expect(line).toContain(proxied(PROXY));
    const relayArgv = readFileSync(`/proc/${child.pid}/cmdline`, "utf8");
    expect(relayArgv).not.toContain("s3cret");
    const childPid = readFileSync(`/proc/${child.pid}/task/${child.pid}/children`, "utf8").trim().split(/\s+/)[0];
    expect(childPid).toBeTruthy();
    const bwrapArgv = readFileSync(`/proc/${childPid}/cmdline`, "utf8");
    expect(bwrapArgv).toContain("bwrap");
    expect(bwrapArgv).not.toContain("s3cret");
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

  describe("account config sync", () => {
    it("syncs settings.json across all accounts idempotently without touching per-account identity or auth files", async () => {
      const defaultSettings = JSON.stringify({ allowNonWorkspaceAccess: true, toolPermission: "always-proceed" }, null, 2);
      writeFileSync(path.join(stateDir(), "settings.json"), defaultSettings, { mode: 0o600 });
      writeFileSync(path.join(stateDir(), "installation_id"), "default-install-id");
      mkdirSync(path.join(home, ".gemini", "config"), { recursive: true });
      writeFileSync(path.join(home, ".gemini", "AGENTS.md"), "# rules\n");
      writeFileSync(path.join(home, ".gemini", "config", "skills.json"), '{"entries":[]}');

      account(accountDir("acc2"), { usage: { gemini5h: 1, geminiWeekly: 1 }, label: "acc2", proxy: PROXY });
      writeFileSync(path.join(accountDir("acc2"), "antigravity-oauth-token"), '{"id_token_email":"acc2@example.com"}');
      writeFileSync(path.join(accountDir("acc2"), "installation_id"), "acc2-install-id");
      writeFileSync(path.join(accountDir("acc2"), "jetski_state.pbtxt"), 'installation_uuid: "acc2-uuid"\n');
      writeFileSync(path.join(accountDir("acc2"), "settings.json"), '{"allowNonWorkspaceAccess":false}');

      account(accountDir("acc4"), { signedIn: false, proxy: PROXY });

      const first = await launch({}, ["sync"]);
      expect(first.code).toBe(0);
      const firstReport = JSON.parse(first.stdout);
      expect(firstReport.sharedFiles["AGENTS.md"]).toBe(true);
      expect(firstReport.sharedFiles["config/skills.json"]).toBe(true);
      expect(firstReport.accounts.map((a: { account: string; settings: string }) => [a.account, a.settings])).toEqual([
        ["default", "default"],
        ["acc2", "updated"],
        ["acc4", "updated"],
      ]);

      expect(readFileSync(path.join(accountDir("acc2"), "settings.json"), "utf8")).toBe(defaultSettings);
      expect(readFileSync(path.join(accountDir("acc4"), "settings.json"), "utf8")).toBe(defaultSettings);
      expect(statSync(path.join(accountDir("acc2"), "settings.json")).mode & 0o777).toBe(0o600);
      expect(readFileSync(path.join(accountDir("acc2"), "antigravity-oauth-token"), "utf8")).toBe('{"id_token_email":"acc2@example.com"}');
      expect(readFileSync(path.join(accountDir("acc2"), "installation_id"), "utf8")).toBe("acc2-install-id");
      expect(readFileSync(path.join(accountDir("acc2"), "jetski_state.pbtxt"), "utf8")).toBe('installation_uuid: "acc2-uuid"\n');
      expect(readFileSync(path.join(accountDir("acc2"), "agy-pool-proxy"), "utf8").trim()).toBe(PROXY);

      const second = await launch({}, ["sync"]);
      expect(second.code).toBe(0);
      const secondReport = JSON.parse(second.stdout);
      expect(secondReport.accounts.map((a: { account: string; settings: string }) => [a.account, a.settings])).toEqual([
        ["default", "default"],
        ["acc2", "unchanged"],
        ["acc4", "unchanged"],
      ]);
    });

    it("refreshes settings.json automatically when launching a non-default account", async () => {
      const updated = JSON.stringify({ allowNonWorkspaceAccess: true, artifactReviewPolicy: "always-proceed" }, null, 2);
      writeFileSync(path.join(stateDir(), "settings.json"), updated, { mode: 0o600 });
      account(accountDir("alt"), { usage: { gemini5h: 1, geminiWeekly: 1 }, label: "alt" });
      writeFileSync(path.join(accountDir("alt"), "settings.json"), '{"stale":true}');

      const run = await launch({ BB_THREAD_ID: "thr_sync_on_launch" });
      expect(run.code).toBe(0);
      expect(accountOf(run.stdout)).toBe("alt");
      expect(readFileSync(path.join(accountDir("alt"), "settings.json"), "utf8")).toBe(updated);
    });
  });
});

describe("ensureMachineId", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "agy-machine-id-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes 32 lowercase hex digits and a newline, readable only by the owner", () => {
    const file = ensureMachineId(path.join(dir, "acc"));
    expect(file).toBe(path.join(dir, "acc", MACHINE_ID_FILE));
    expect(readFileSync(file, "utf8")).toMatch(/^[0-9a-f]{32}\n$/);
    expect(statSync(file).size).toBe(33);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("keeps an existing valid id, with or without its newline", () => {
    const file = ensureMachineId(dir);
    const first = readFileSync(file, "utf8");
    ensureMachineId(dir);
    expect(readFileSync(file, "utf8")).toBe(first);
    writeFileSync(file, "0123456789abcdef0123456789abcdef");
    ensureMachineId(dir);
    expect(readFileSync(file, "utf8")).toBe("0123456789abcdef0123456789abcdef");
  });

  it("replaces an invalid id", () => {
    const file = path.join(dir, MACHINE_ID_FILE);
    for (const bad of ["", "not-an-id\n", "0123456789ABCDEF0123456789ABCDEF\n", "0123456789abcdef\n"]) {
      writeFileSync(file, bad);
      ensureMachineId(dir);
      expect(readFileSync(file, "utf8")).toMatch(/^[0-9a-f]{32}\n$/);
    }
  });
});

describe("accountCommand machine id", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "agy-command-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const usable = (accountName: string, dir: string): UsableAccount => ({
    name: accountName as AccountName,
    dir,
    disabled: false,
    disabledReason: null,
    egress: { kind: "direct" },
  });

  it("binds an added account's id over /etc/machine-id read-only, and only when the account has one", () => {
    const paths = poolPaths({ AGY_POOL_ACCOUNTS_DIR: path.join(root, "accounts") }, path.join(root, "home"));
    const dir = path.join(root, "accounts", "alt");
    mkdirSync(dir, { recursive: true });
    const before = accountCommand(paths, usable("alt", dir), "agy", ["acp"]).args;
    expect(before).not.toContain(HOST_MACHINE_ID);
    expect(existsSync(path.join(dir, MACHINE_ID_FILE))).toBe(false);

    const file = ensureMachineId(dir);
    const args = accountCommand(paths, usable("alt", dir), "agy", ["acp"]).args;
    const at = args.indexOf("--ro-bind");
    expect(args.slice(at, at + 3)).toEqual(["--ro-bind", file, HOST_MACHINE_ID]);
    expect(args.indexOf("agy")).toBeGreaterThan(at);
  });

  it("leaves the default account unsandboxed", () => {
    const paths = poolPaths({}, path.join(root, "home"));
    ensureMachineId(paths.agyStateDir);
    const command = accountCommand(paths, usable("default", paths.agyStateDir), "agy", ["acp"]);
    expect(command.command).toBe("agy");
    expect(command.args).toEqual(["acp"]);
  });
});
