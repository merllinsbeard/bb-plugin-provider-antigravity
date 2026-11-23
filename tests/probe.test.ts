import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPrintRunner,
  hasAuthToken,
  probeQuota,
  resolveAgyBinary,
  withSingleFlight,
  type PrintRun,
  type ProbePorts,
} from "../src/usage/probe.js";

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const fakeHome = path.join(fixtures, "home");
const fakeAgy = path.join(fakeHome, ".local", "bin", "agy");
const liveJson = readFileSync(path.join(fixtures, "usage-live.json"), "utf8");

function ports(run: PrintRun | (() => Promise<PrintRun>), overrides: Partial<ProbePorts> = {}) {
  const runPrint = vi.fn(typeof run === "function" ? run : async () => run);
  return { locateBinary: () => "/opt/agy", hasAuthToken: () => true, runPrint, ...overrides };
}

const exited = (stdout: string, code: number | null = 0, stderr = ""): PrintRun => ({ kind: "exited", code, stdout, stderr });

describe("probeQuota", () => {
  it("reads live quota windows from a successful run", async () => {
    const p = ports(exited(liveJson));
    const outcome = await probeQuota(p);
    expect(p.runPrint).toHaveBeenCalledWith("/opt/agy");
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.reading.accountEmail).toBeNull();
      expect(outcome.reading.planLabel).toBeNull();
      expect(outcome.reading.windows.map((window) => window.label)).toEqual([
        "Gemini · Weekly",
        "Gemini · 5h",
        "Claude & GPT · Weekly",
        "Claude & GPT · 5h",
        "Gemini 4 Argon · Weekly",
      ]);
    }
  });

  it("reports not_installed without spawning when agy is missing", async () => {
    const p = ports(exited(liveJson), { locateBinary: () => null });
    expect(await probeQuota(p)).toEqual({ ok: false, failure: { status: "not_installed" } });
    expect(p.runPrint).not.toHaveBeenCalled();
  });

  it("reports unauthenticated without spawning when no sign-in token exists", async () => {
    const p = ports(exited(liveJson), { hasAuthToken: () => false });
    expect(await probeQuota(p)).toEqual({ ok: false, failure: { status: "unauthenticated" } });
    expect(p.runPrint).not.toHaveBeenCalled();
  });

  it("reports expired when agy asked for authentication", async () => {
    expect(await probeQuota(ports({ kind: "aborted-auth" }))).toEqual({ ok: false, failure: { status: "expired" } });
  });

  it.each<[string, PrintRun, RegExp]>([
    ["timeout", { kind: "timeout" }, /within 20 s/],
    ["oversized output", { kind: "output-too-large" }, /4 MiB/],
    ["spawn failure", { kind: "spawn-failed", message: "EACCES" }, /Could not start agy: EACCES/],
    ["non-zero exit", exited("", 3, "starting\nbackend unavailable\n"), /exited with code 3: backend unavailable$/],
    ["non-zero exit with provider JSON", exited(JSON.stringify({ status: "ERROR", response: "rate limited" }), 1), /code 1: rate limited$/],
    ["killed by a signal", exited("", null), /exited with code null\.$/],
    ["provider error", exited(JSON.stringify({ status: "ERROR", response: "quota backend down" })), /agy \/usage failed: quota backend down/],
    ["malformed JSON", exited("Loading..."), /unreadable quota data/],
  ])("reports an error for %s", async (_, run, message) => {
    const outcome = await probeQuota(ports(run));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.status).toBe("error");
      if (outcome.failure.status === "error") expect(outcome.failure.message).toMatch(message);
    }
  });

  it("explains a print mode that did not expand /usage without suggesting a PTY", async () => {
    const outcome = await probeQuota(ports(exited(JSON.stringify({ status: "SUCCESS", response: "Sure" }))));
    expect(outcome).toEqual({
      ok: false,
      failure: { status: "error", message: expect.stringContaining("did not return structured /usage JSON") },
    });
    if (!outcome.ok && outcome.failure.status === "error") expect(outcome.failure.message).not.toMatch(/PTY|TUI|BB_/);
  });
});

describe("createPrintRunner against a fake agy", () => {
  let scratch: string;
  let log: string;

  beforeEach(() => {
    scratch = mkdtempSync(path.join(tmpdir(), "agy-probe-"));
    log = path.join(scratch, "calls.log");
    vi.stubEnv("AGY_FAKE_LOG", log);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(scratch, { recursive: true, force: true });
  });

  const calls = () => readFileSync(log, "utf8").trim().split("\n");

  it("runs the documented print-mode command and returns its stdout", async () => {
    vi.stubEnv("BB_PROBE_MARKER", "leaked");
    const run = await createPrintRunner()(fakeAgy);
    expect(run).toEqual({ kind: "exited", code: 0, stdout: liveJson, stderr: "" });
    expect(calls()).toEqual(["-p /usage --output-format json --print-timeout 15s|marker="]);
  });

  it("gives agy a closed stdin so it never waits for input", async () => {
    vi.stubEnv("AGY_FAKE_MODE", "stdin");
    expect(await createPrintRunner({ killAfterMs: 5_000 })(fakeAgy)).toMatchObject({ kind: "exited", code: 0, stdout: liveJson });
  });

  it("kills agy as soon as it asks for authentication", async () => {
    vi.stubEnv("AGY_FAKE_MODE", "auth");
    const started = Date.now();
    expect(await createPrintRunner()(fakeAgy)).toEqual({ kind: "aborted-auth" });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("kills agy when it outlives the backstop", async () => {
    vi.stubEnv("AGY_FAKE_MODE", "hang");
    expect(await createPrintRunner({ killAfterMs: 300 })(fakeAgy)).toEqual({ kind: "timeout" });
  });

  it("kills agy when stdout exceeds the cap", async () => {
    vi.stubEnv("AGY_FAKE_MODE", "flood");
    expect(await createPrintRunner({ maxStdoutBytes: 1_000 })(fakeAgy)).toEqual({ kind: "output-too-large" });
  });

  it("captures stderr and the exit code of a failing run", async () => {
    vi.stubEnv("AGY_FAKE_MODE", "fail");
    expect(await createPrintRunner()(fakeAgy)).toEqual({
      kind: "exited",
      code: 3,
      stdout: "",
      stderr: "starting\nbackend unavailable\n",
    });
  });

  it("reports a binary that cannot be started", async () => {
    expect(await createPrintRunner()(path.join(scratch, "missing-agy"))).toMatchObject({ kind: "spawn-failed" });
  });
});

describe("resolveAgyBinary", () => {
  const noPath = () => null;
  const notExecutable = path.join(fixtures, "usage-live.json");

  it("prefers BB_ANTIGRAVITY_EXECUTABLE when it is executable", () => {
    expect(resolveAgyBinary({ BB_ANTIGRAVITY_EXECUTABLE: fakeAgy }, "/nowhere", () => "/usr/bin/true")).toBe(fakeAgy);
  });

  it("falls back to PATH, then to ~/.local/bin/agy, skipping non-executable candidates", () => {
    expect(resolveAgyBinary({ BB_ANTIGRAVITY_EXECUTABLE: notExecutable }, "/nowhere", () => fakeAgy)).toBe(fakeAgy);
    expect(resolveAgyBinary({}, fakeHome, () => notExecutable)).toBe(fakeAgy);
    expect(resolveAgyBinary({}, fakeHome, noPath)).toBe(fakeAgy);
  });

  it("returns null when no candidate is executable", () => {
    expect(resolveAgyBinary({ BB_ANTIGRAVITY_EXECUTABLE: notExecutable }, "/nowhere", noPath)).toBeNull();
  });
});

describe("hasAuthToken", () => {
  it("detects the sign-in token by presence only", () => {
    const home = mkdtempSync(path.join(tmpdir(), "agy-home-"));
    try {
      expect(hasAuthToken(home)).toBe(false);
      mkdirSync(path.join(home, ".gemini", "antigravity-cli"), { recursive: true });
      writeFileSync(path.join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token"), "");
      expect(hasAuthToken(home)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("withSingleFlight", () => {
  it("shares one call between concurrent callers and starts a new one afterwards", async () => {
    let release!: (value: number) => void;
    const fn = vi.fn(() => new Promise<number>((resolve) => (release = resolve)));
    const read = withSingleFlight(fn);
    const first = read();
    const second = read();
    release(7);
    expect(await Promise.all([first, second])).toEqual([7, 7]);
    expect(fn).toHaveBeenCalledTimes(1);
    const third = read();
    release(8);
    expect(await third).toBe(8);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("lets the next call retry after a failure", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce("ok");
    const read = withSingleFlight(fn as () => Promise<string>);
    await expect(read()).rejects.toThrow("boom");
    expect(await read()).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
