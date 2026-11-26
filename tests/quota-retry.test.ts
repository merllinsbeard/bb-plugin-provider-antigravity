import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { registerQuotaHandoff } from "../src/quota-handoff.ts";
import { classifyFailure, registerQuotaRetry } from "../src/quota-retry.ts";

const NOW = Date.parse("2026-11-26T12:00:00.000Z");
const MIN = 60_000;
const inMinutes = (minutes: number) => new Date(NOW + minutes * MIN).toISOString();
const poolOut = (resetsAt: string, family = "Gemini") =>
  `agy-pool: every Antigravity account is out of ${family} quota. The nearest reset is ${resetsAt} (account "acc2").`;

type Thread = Partial<Parameters<typeof makeThreadResponse>[0]>;
type Failure = { message: string; detail?: string; type?: "system/error" | "provider/error" };
type Setup = {
  settings?: Record<string, string | boolean | number>;
  threads: Record<string, Thread>;
  /** The error that failed each thread's latest turn; a thread without one has only its turn request on top. */
  errors?: Record<string, Failure>;
  /** What core answers to `threads.retry`; it accepts by default. */
  retry?: (args: unknown) => Promise<unknown>;
};

const CHILD: Thread = { parentThreadId: "thr_parent" };
const WORKER: Thread = { parentThreadId: "thr_origin", visibility: "hidden", originPluginId: "workflows" };
const OWNER: Thread = {};

/** Both quota listeners on one fake host, wired the way `server.ts` wires them. */
function host({ settings = {}, threads, errors = {}, retry = async () => ({ delivery: "queued" }) }: Setup) {
  const metadata = new Map<string, Record<string, unknown>>();
  let spawned = 0;
  const { bb, harness } = createFakePluginHost({
    pluginId: "provider-antigravity",
    settings,
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) => {
          const thread = threads[threadId];
          if (thread === undefined) throw Object.assign(new Error(`Thread ${threadId} not found`), { status: 404 });
          return makeThreadResponse({ id: threadId, providerId: "antigravity", visibility: "visible", projectId: "proj_p", environmentId: "env_e", ...thread });
        },
        events: {
          list: async ({ threadId, order }: { threadId: string; order?: string }) => {
            const error = errors[threadId];
            const rows = [
              { id: `req_${threadId}`, seq: 1, type: "client/turn/requested", data: {} },
              ...(error === undefined
                ? []
                : [{ id: `evt_${threadId}`, seq: 2, type: error.type ?? "provider/error", data: { message: error.message, detail: error.detail } }]),
            ];
            return order === "desc" ? rows.reverse().slice(0, 1) : rows;
          },
        },
        retry,
        getPluginMetadata: async ({ threadId }: { threadId: string }) => metadata.get(threadId) ?? {},
        updatePluginMetadata: async ({ threadId, set }: { threadId: string; set: Record<string, unknown> }) => {
          metadata.set(threadId, { ...metadata.get(threadId), ...set });
          return metadata.get(threadId);
        },
        defaultExecutionOptions: async () => null,
        spawn: async () => ({ id: `thr_next${++spawned}` }),
      },
      plugins: { callRpc: async () => ({ ok: true, channels: ["mobile"] }) },
    } as never,
  });
  registerQuotaRetry(bb, registerQuotaHandoff(bb));

  /** bb's two announcements of one failed turn: `turn.failed` for retry policies, `thread.failed` for the hand-off. */
  const fail = async (threadId: string, turn: { attemptNumber?: number; errorInfo?: unknown } = {}) => {
    const retried = await harness.behavior.emitThreadEvent("turn.failed", {
      threadId,
      requestId: `creq_${threadId}`,
      turnId: null,
      errorInfo: (turn.errorInfo ?? null) as never,
      inputAccepted: true,
      rateLimits: null,
      attemptNumber: turn.attemptNumber ?? 1,
      originPluginId: null,
    });
    const handedOff = await harness.behavior.emitThreadEvent("thread.failed", {
      thread: await bb.sdk.threads.get({ threadId }).catch(() => makeThreadResponse({ id: threadId })),
      error: null,
    });
    return [...retried.errors, ...handedOff.errors];
  };
  const retries = () => harness.inspection.sdk.callsTo("threads.retry").map(([args]) => args as { threadId: string; turnRequestId: string; sendAt: number; reason: string });
  const spawns = () => harness.inspection.sdk.callsTo("threads.spawn");
  return { fail, retries, spawns };
}

let random = 0.5;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  random = 0.5;
  vi.spyOn(Math, "random").mockImplementation(() => random);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("retry after a short whole-pool quota pause", () => {
  it("queues a child thread's turn 15-45 s after a reset 20 minutes away", async () => {
    const reset = NOW + 20 * MIN;
    for (const [value, delay] of [
      [0, 15_000],
      [0.5, 30_000],
      [0.99, 44_700],
    ] as const) {
      random = value;
      const { fail, retries } = host({ threads: { thr_child: CHILD }, errors: { thr_child: { message: "Provider error", detail: poolOut(inMinutes(20)) } } });
      expect(await fail("thr_child")).toEqual([]);
      expect(retries()).toEqual([{ threadId: "thr_child", turnRequestId: "creq_thr_child", sendAt: reset + delay, reason: "Antigravity Gemini quota resets at 12:20 UTC" }]);
    }
  });

  it("queues a workflow worker whose reset is 45 minutes away, and a thread that failed at start-up", async () => {
    const { fail, retries } = host({
      threads: { thr_worker: WORKER, thr_start: CHILD },
      errors: {
        thr_worker: { message: "Provider error", detail: poolOut(inMinutes(45), "Claude/GPT") },
        thr_start: {
          type: "system/error",
          message: "Command thread.start failed",
          detail: `ACP agent "agy-pool" exited (code 1, signal null): agy-pool: every Antigravity account is out of quota. The nearest reset is ${inMinutes(5)} (account "acc2").`,
        },
      },
    });
    await fail("thr_worker");
    await fail("thr_start");
    expect(retries().map(({ threadId, sendAt, reason }) => ({ threadId, sendAt, reason }))).toEqual([
      { threadId: "thr_worker", sendAt: NOW + 45 * MIN + 30_000, reason: "Antigravity Claude/GPT quota resets at 12:45 UTC" },
      { threadId: "thr_start", sendAt: NOW + 5 * MIN + 30_000, reason: "Antigravity quota resets at 12:05 UTC" },
    ]);
  });

  it("retries right after a reset that already passed", async () => {
    const { fail, retries } = host({ threads: { thr_child: CHILD }, errors: { thr_child: { message: poolOut(inMinutes(-1)) } } });
    await fail("thr_child");
    expect(retries()[0]?.sendAt).toBe(NOW + 30_000);
  });

  it("fails at once when the reset is a weekly one days away, or unknown, so the parent can fall back", async () => {
    const { fail, retries } = host({
      threads: { thr_week: CHILD, thr_unknown: CHILD },
      errors: {
        thr_week: { message: poolOut(inMinutes(4 * 24 * 60)) },
        thr_unknown: { message: "agy-pool: every Antigravity account is out of Gemini quota." },
      },
    });
    await fail("thr_week");
    await fail("thr_unknown");
    expect(retries()).toEqual([]);
  });

  it("follows quotaRetryMaxWaitMinutes: longer waits when raised, no quota retries at 0", async () => {
    const errors = { thr_child: { message: poolOut(inMinutes(90)) } };
    const raised = host({ settings: { quotaRetryMaxWaitMinutes: 120 }, threads: { thr_child: CHILD }, errors });
    await raised.fail("thr_child");
    expect(raised.retries()).toHaveLength(1);

    const off = host({ settings: { quotaRetryMaxWaitMinutes: 0 }, threads: { thr_child: CHILD }, errors: { thr_child: { message: poolOut(inMinutes(5)) } } });
    await off.fail("thr_child");
    expect(off.retries()).toEqual([]);
  });
});

describe("a visible top-level thread whose pool is out", () => {
  const errors = { thr_owner: { message: "Provider error", detail: poolOut(inMinutes(20)) } };

  it("hands off and queues no retry while the hand-off is on", async () => {
    const { fail, retries, spawns } = host({ threads: { thr_owner: OWNER }, errors });
    expect(await fail("thr_owner")).toEqual([]);
    expect(spawns()).toHaveLength(1);
    expect(retries()).toEqual([]);
  });

  it("waits for the reset instead when the hand-off is off", async () => {
    const { fail, retries, spawns } = host({ settings: { quotaHandoff: false }, threads: { thr_owner: OWNER }, errors });
    await fail("thr_owner");
    expect(spawns()).toHaveLength(0);
    expect(retries()).toMatchObject([{ threadId: "thr_owner", sendAt: NOW + 20 * MIN + 30_000 }]);
  });
});

describe("retry after a transient failure", () => {
  const transient = {
    thr_capacity: { message: "Provider error", detail: "503 Service Unavailable: No capacity available for model gemini-4-neon" },
    thr_swap: { message: "Provider error", detail: "agy exited during account swap" },
    thr_reset: { message: "Provider error", detail: "read ECONNRESET" },
  };

  it("backs off 15 s doubling per attempt with jitter, on owner, child and worker threads alike", async () => {
    random = 0;
    const { fail, retries, spawns } = host({ threads: { thr_capacity: OWNER, thr_swap: CHILD, thr_reset: WORKER }, errors: transient });
    await fail("thr_capacity");
    await fail("thr_swap", { attemptNumber: 2 });
    await fail("thr_reset", { attemptNumber: 4 });
    expect(spawns()).toHaveLength(0);
    expect(retries().map(({ threadId, sendAt, reason }) => ({ threadId, sendAt, reason }))).toEqual([
      { threadId: "thr_capacity", sendAt: NOW + 15_000, reason: "Antigravity: Google is out of capacity (retry 1 of 4)" },
      { threadId: "thr_swap", sendAt: NOW + 30_000, reason: "Antigravity: agy restarted during an account swap (retry 2 of 4)" },
      { threadId: "thr_reset", sendAt: NOW + 120_000, reason: "Antigravity: connection dropped (retry 4 of 4)" },
    ]);
  });

  it("adds up to one more step of jitter", async () => {
    random = 0.5;
    const first = host({ threads: { thr_swap: CHILD }, errors: transient });
    await first.fail("thr_swap", { attemptNumber: 3 });
    expect(first.retries()[0]?.sendAt).toBe(NOW + 60_000 + 30_000);

    random = 0.75;
    const last = host({ threads: { thr_swap: CHILD }, errors: transient });
    await last.fail("thr_swap", { attemptNumber: 4 });
    expect(last.retries()[0]?.sendAt).toBe(NOW + 120_000 + 90_000);
  });
});

describe("what is never retried", () => {
  it("leaves refusals retrying cannot fix, the fifth failed attempt and other providers alone", async () => {
    const { fail, retries } = host({
      threads: { thr_auth: CHILD, thr_region: CHILD, thr_model: CHILD, thr_tired: CHILD, thr_claude: { ...CHILD, providerId: "claude-code" }, thr_quiet: CHILD },
      errors: {
        thr_auth: { message: "Provider error", detail: "403 PERMISSION_DENIED: The caller does not have permission" },
        thr_region: { message: "Provider error", detail: "UNSUPPORTED_LOCATION: User location is not supported (503 upstream)" },
        thr_model: { type: "system/error", message: "Command thread.start failed", detail: "Unknown model ID: gemini-4-neon" },
        thr_tired: { message: "Provider error", detail: "agy exited during account swap" },
        thr_claude: { message: "Provider error", detail: "503 No capacity" },
      },
    });
    for (const id of ["thr_auth", "thr_region", "thr_model", "thr_claude", "thr_quiet"]) await fail(id);
    await fail("thr_tired", { attemptNumber: 5 });
    expect(retries()).toEqual([]);
  });

  it("leaves a failure bb's provider-retry already reschedules from its structured error to provider-retry", async () => {
    const { fail, retries } = host({ threads: { thr_child: CHILD }, errors: { thr_child: { message: "Provider error", detail: "503 No capacity" } } });
    await fail("thr_child", { errorInfo: { category: "overloaded", httpStatusCode: 503, providerCode: null } });
    expect(retries()).toEqual([]);
  });

  it("queues one retry when bb announces the failure twice, and takes core's refusal of a second row quietly", async () => {
    const once = host({ threads: { thr_child: CHILD }, errors: { thr_child: { message: "agy exited during account swap" } } });
    await Promise.all([once.fail("thr_child"), once.fail("thr_child")]);
    expect(once.retries()).toHaveLength(1);

    const refused = host({
      threads: { thr_child: CHILD },
      errors: { thr_child: { message: "agy exited during account swap" } },
      retry: async () => Promise.reject(Object.assign(new Error("Turn creq_thr_child already has a retry waiting"), { status: 409, code: "retry_already_queued" })),
    });
    expect(await refused.fail("thr_child")).toEqual([]);
  });

  it("survives a thread deleted before the listener reads it", async () => {
    const { fail, retries } = host({ threads: {} });
    expect(await fail("thr_gone")).toEqual([]);
    expect(retries()).toEqual([]);
  });
});

describe("classifyFailure", () => {
  it("reads the pool's exhaustion first, then refusals that stay, then transient causes", () => {
    expect(classifyFailure(poolOut("2026-11-26T12:20:00.000Z"))).toEqual({
      kind: "pool-exhausted",
      exhaustion: { family: "Gemini", resetsAt: "2026-11-26T12:20:00.000Z" },
    });
    expect(classifyFailure("SUBSCRIPTION_REQUIRED")).toEqual({ kind: "non-retryable" });
    expect(classifyFailure('agy-pool: account "acc3" is unusable: proxy file is not a URL')).toEqual({ kind: "non-retryable" });
    expect(classifyFailure("⚠ Individual quota reached. RESOURCE_EXHAUSTED")).toEqual({ kind: "transient", label: "short quota throttle" });
    expect(classifyFailure("HTTP 502 Bad Gateway")).toEqual({ kind: "transient", label: "Google server error" });
    expect(classifyFailure("model is overloaded, try later")).toEqual({ kind: "transient", label: "Google is out of capacity" });
    expect(classifyFailure('agy-pool: account "acc2" is out of Gemini quota and the prompt could not move to another account.')).toEqual({
      kind: "transient",
      label: "account failover did not finish",
    });
    expect(classifyFailure("")).toEqual({ kind: "non-retryable" });
  });
});
