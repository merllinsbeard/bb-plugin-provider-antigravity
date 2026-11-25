import { describe, expect, it } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { registerQuotaHandoff, parsePoolExhaustion } from "../src/quota-handoff.ts";

const POOL_OUT =
  'agy-pool: every Antigravity account is out of Claude/GPT quota. The nearest reset is 2026-11-25T15:02:36.133Z (account "acc5").';

type Row = { id: string; type: string; data?: Record<string, unknown> };
type Failure = { id: string; message: string; detail?: string; type?: "system/error" | "provider/error" };
type Setup = {
  settings?: Record<string, string | boolean>;
  /** The error that failed each thread's latest turn, written after that turn's request. */
  errors?: Record<string, Failure>;
  /** A thread's whole event log, oldest first, for cases one error cannot describe. */
  logs?: Record<string, Row[]>;
  /** What the push-notifications plugin does with a notification; it answers ok by default. */
  notify?: (input: unknown) => Promise<unknown>;
};

/** A plugin host whose thread metadata lives in a map the test owns, so it survives a plugin reload like bb's does. */
function host({ settings = {}, errors = {}, logs = {}, notify = async () => ({ ok: true, channels: ["mobile"] }) }: Setup = {}) {
  const metadata = new Map<string, Record<string, unknown>>();
  const notifications: { pluginId: string; method: string; input: any }[] = [];
  let spawned = 0;
  const log = (threadId: string): Row[] => {
    if (logs[threadId] !== undefined) return logs[threadId];
    const error = errors[threadId];
    return error === undefined
      ? []
      : [
          { id: `req_${error.id}`, type: "client/turn/requested" },
          { id: error.id, type: error.type ?? "system/error", data: { message: error.message, detail: error.detail } },
        ];
  };
  const { bb, harness } = createFakePluginHost({
    pluginId: "provider-antigravity",
    settings,
    sdk: {
      threads: {
        events: {
          // Like bb: oldest first unless `order: "desc"`, filtered by `types`, cut to `limit`.
          list: async ({ threadId, types, order, limit }: { threadId: string; types?: string[]; order?: string; limit?: string }) => {
            const rows = log(threadId)
              .map((row, index) => ({ ...row, seq: index + 1, data: row.data ?? {} }))
              .filter((row) => types === undefined || types.includes(row.type));
            if (order === "desc") rows.reverse();
            return limit === undefined ? rows : rows.slice(0, Number(limit));
          },
        },
        getPluginMetadata: async ({ threadId }: { threadId: string }) => metadata.get(threadId) ?? {},
        updatePluginMetadata: async ({ threadId, set }: { threadId: string; set: Record<string, unknown> }) => {
          const next = { ...metadata.get(threadId), ...set };
          metadata.set(threadId, next);
          return next;
        },
        defaultExecutionOptions: async () => ({ model: "claude-opus-5-5", permissionMode: "full", reasoningLevel: "medium", serviceTier: "default", source: "client/turn/requested" }),
        spawn: async () => ({ id: `thr_next${++spawned}` }),
      },
      plugins: {
        callRpc: async ({ pluginId, method, input }: { pluginId: string; method: string; input: unknown }) => {
          notifications.push({ pluginId, method, input });
          return notify(input);
        },
      },
    } as never,
  });
  registerQuotaHandoff(bb);
  const fail = (thread: Partial<Parameters<typeof makeThreadResponse>[0]> & { id: string }) =>
    harness.behavior.emitThreadEvent("thread.failed", {
      thread: makeThreadResponse({ providerId: "antigravity", projectId: "proj_p", environmentId: "env_e", visibility: "visible", ...thread }),
      error: errors[thread.id]?.message ?? null,
    });
  const spawns = () => harness.inspection.sdk.callsTo("threads.spawn").map(([args]) => args as any);
  return { bb, harness, fail, spawns, metadata, notifications };
}

describe("parsePoolExhaustion", () => {
  it("reads the family and nearest reset from the pool's message, wherever it sits", () => {
    expect(parsePoolExhaustion(POOL_OUT)).toEqual({ family: "Claude/GPT", resetsAt: "2026-11-25T15:02:36.133Z" });
    expect(parsePoolExhaustion(`ACP agent "agy-pool" exited (code 1, signal null): agy-pool: every Antigravity account is out of quota.`)).toEqual({
      family: null,
      resetsAt: null,
    });
    expect(parsePoolExhaustion("⚠ Individual quota reached. Resets in 3h.")).toBeNull();
  });
});

describe("quota hand-off", () => {
  const errors = { thr_src: { id: "evt_1", message: POOL_OUT } };

  it("continues a visible top-level thread on Claude Code Opus medium in the same environment", async () => {
    const { fail, spawns, metadata } = host({ errors });
    await fail({ id: "thr_src", title: "Fix the thing" });

    const [spawn] = spawns();
    expect(spawns()).toHaveLength(1);
    expect(spawn).toMatchObject({
      projectId: "proj_p",
      environment: { type: "reuse", environmentId: "env_e" },
      providerId: "claude-code",
      model: "claude-opus-5-5",
      reasoningLevel: "medium",
      permissionMode: "full",
    });
    const [input] = spawn.input;
    expect(input.text).toMatch(/^Continue from @thread:thr_src\n\n.*out of Claude\/GPT quota until 2026-11-25T15:02:36\.133Z/);
    expect(input.mentions[0]).toMatchObject({ start: 14, end: 14 + "@thread:thr_src".length, resource: { kind: "thread", threadId: "thr_src" } });
    expect(metadata.get("thr_src")).toEqual({ quotaHandoff: { failureEventId: "evt_1", successorThreadId: "thr_next1" } });
  });

  it("names the successor after the failed thread and sends a notification that opens the successor", async () => {
    const { fail, spawns, notifications } = host({ errors });
    await fail({ id: "thr_src", title: "Пост с отзывами" });

    expect(spawns()[0].title).toBe("Пост с отзывами");
    expect(notifications).toEqual([
      {
        pluginId: "push-notifications",
        method: "notifications.send",
        input: {
          title: "Continued in a new thread: Пост с отзывами",
          body: "Every Antigravity account is out of Claude/GPT quota until 15:02 UTC. The task goes on in a new thread; open it from here.",
          threadId: "thr_next1",
        },
      },
    ]);
  });

  it("keeps the hand-off when no notification channel takes the notice", async () => {
    const { fail, spawns, metadata } = host({ errors, notify: async () => Promise.reject(new Error("not_delivered")) });
    await fail({ id: "thr_src", title: null });
    expect(spawns()).toHaveLength(1);
    expect(spawns()[0]).not.toHaveProperty("title");
    expect(metadata.get("thr_src")).toEqual({ quotaHandoff: { failureEventId: "evt_1", successorThreadId: "thr_next1" } });
  });

  it("hands off a mid-session failure, which bb records as provider/error with the pool message in detail", async () => {
    const { fail, spawns, metadata } = host({
      errors: { thr_src: { id: "evt_p", type: "provider/error", message: "Provider error", detail: POOL_OUT } },
    });
    await fail({ id: "thr_src" });
    expect(spawns()).toHaveLength(1);
    expect(spawns()[0].input[0].text).toContain("out of Claude/GPT quota until 2026-11-25T15:02:36.133Z");
    expect(metadata.get("thr_src")).toEqual({ quotaHandoff: { failureEventId: "evt_p", successorThreadId: "thr_next1" } });
  });

  it("ignores an exhaustion error from an earlier turn when the latest turn failed otherwise", async () => {
    const stale: Row[] = [
      { id: "req_1", type: "client/turn/requested" },
      { id: "evt_old", type: "system/error", data: { message: "Command thread.start failed", detail: POOL_OUT } },
      { id: "req_2", type: "client/turn/requested" },
    ];
    const { fail, spawns } = host({
      logs: {
        thr_unrelated: [...stale, { id: "evt_new", type: "provider/error", data: { message: "Provider error", detail: "agy exited during account swap" } }],
        thr_no_error: stale,
      },
    });
    await fail({ id: "thr_unrelated" });
    await fail({ id: "thr_no_error" });
    expect(spawns()).toHaveLength(0);
  });

  it("hands off a start-up failure, whose pool message sits in the error detail", async () => {
    const { fail, spawns } = host({
      errors: { thr_src: { id: "evt_1", message: "Command thread.start failed", detail: `ACP agent exited (code 1, signal null): ${POOL_OUT}` } },
    });
    await fail({ id: "thr_src" });
    expect(spawns()).toHaveLength(1);
  });

  it("leaves child, hidden and plugin-started threads, other providers and other failures alone", async () => {
    const { fail, spawns } = host({
      errors: {
        thr_child: { id: "e1", message: POOL_OUT },
        thr_hidden: { id: "e2", message: POOL_OUT },
        thr_plugin: { id: "e3", message: POOL_OUT },
        thr_codex: { id: "e4", message: POOL_OUT },
        thr_other: { id: "e5", message: "agy exited during account swap" },
      },
    });
    await fail({ id: "thr_child", parentThreadId: "thr_parent" });
    await fail({ id: "thr_hidden", visibility: "hidden" });
    await fail({ id: "thr_plugin", originPluginId: "bb-recap" });
    await fail({ id: "thr_codex", providerId: "codex" });
    await fail({ id: "thr_other" });
    expect(spawns()).toHaveLength(0);
  });

  it("hands off one failure once, also after the plugin reloads", async () => {
    const { harness, fail, spawns } = host({ errors });
    await Promise.all([fail({ id: "thr_src" }), fail({ id: "thr_src" })]);
    await harness.lifecycle.reload((next) => registerQuotaHandoff(next));
    await fail({ id: "thr_src" });
    expect(spawns()).toHaveLength(1);
  });

  it("hands off a later failure of the same thread again", async () => {
    const setup = { errors: { thr_src: { id: "evt_1", message: POOL_OUT } } };
    const { fail, spawns } = host(setup);
    await fail({ id: "thr_src" });
    setup.errors.thr_src = { id: "evt_2", message: POOL_OUT };
    await fail({ id: "thr_src" });
    expect(spawns()).toHaveLength(2);
  });

  it("follows the plugin settings: target and the off switch", async () => {
    const custom = host({ errors, settings: { quotaHandoffProvider: "codex", quotaHandoffModel: "gpt-6", quotaHandoffReasoning: "high" } });
    await custom.fail({ id: "thr_src" });
    expect(custom.spawns()[0]).toMatchObject({ providerId: "codex", model: "gpt-6", reasoningLevel: "high" });

    const off = host({ errors, settings: { quotaHandoff: false } });
    await off.fail({ id: "thr_src" });
    expect(off.spawns()).toHaveLength(0);
  });
});
