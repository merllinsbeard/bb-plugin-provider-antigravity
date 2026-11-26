import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseAccountName, shareConversations, type AccountName, type PoolPaths } from "../src/pool/account.ts";
import {
  MAX_PROVIDER_COMMANDS_BYTES,
  fitAvailableCommands,
  fitAvailableCommandsLine,
  providerCommandsPayloadBytes,
} from "../src/pool/commands.ts";
import { QUOTA_MESSAGE, exhaustedUntil, isQuotaError, markExhausted, quotaResetMs, readExhausted } from "../src/pool/exhaustion.ts";

const launcher = fileURLToPath(new URL("../bin/agy-pool", import.meta.url));
const fakeBin = fileURLToPath(new URL("./fixtures/fake-acp-agy", import.meta.url));

function usageJson(gemini5h: number, geminiWeekly = gemini5h): string {
  const bucket = (id: string, window: string, remaining_fraction: number) => ({
    id,
    name: window,
    window,
    remaining_fraction,
    reset_time: new Date(Date.now() + 6 * 24 * 3600_000).toISOString(),
  });
  return JSON.stringify({
    status: "SUCCESS",
    command: {
      name: "usage",
      data: {
        groups: [
          { name: "Gemini Models", buckets: [bucket("gemini-weekly", "weekly", geminiWeekly), bucket("gemini-5h", "5h", gemini5h)] },
        ],
      },
    },
  });
}

describe("exhaustion helpers", () => {
  it("matches agy quota refusals and ignores ordinary prose", () => {
    expect(QUOTA_MESSAGE.test("\n⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 3h18m19s.\n")).toBe(
      true,
    );
    expect(QUOTA_MESSAGE.test("⚠️ RESOURCE_EXHAUSTED: quota reached")).toBe(true);
    expect(QUOTA_MESSAGE.test("The error says Individual quota reached when the window fills.")).toBe(false);
    expect(isQuotaError("RESOURCE_EXHAUSTED: Individual quota reached")).toBe(true);
  });

  it("parses reset durations and falls back to 15 minutes", () => {
    expect(quotaResetMs("Resets in 3h18m19s.")).toBe((3 * 3600 + 18 * 60 + 19) * 1000);
    expect(quotaResetMs("Resets in 36m29s.")).toBe((36 * 60 + 29) * 1000);
    expect(quotaResetMs("Resets in 45s.")).toBe(45 * 1000);
    expect(quotaResetMs("No reset timestamp")).toBe(15 * 60 * 1000);
  });

  it("reads active marks and drops expired ones", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agy-exhaust-"));
    try {
      const file = path.join(dir, "exhausted.json");
      const now = new Date("2026-11-23T16:00:00Z");
      markExhausted(file, parseAccountName("acc2")!, "3p", new Date("2026-11-23T15:00:00Z"));
      markExhausted(file, parseAccountName("acc3")!, "3p", new Date("2026-11-23T19:00:00Z"));
      const active = readExhausted(file, now);
      expect(active.has("acc2" as AccountName)).toBe(false);
      expect(exhaustedUntil(active, "acc3" as AccountName, "3p")).toBe("2026-11-23T19:00:00.000Z");
      expect(exhaustedUntil(active, "acc3" as AccountName, "gemini")).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores version 1 marks, which closed whole accounts", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agy-exhaust-"));
    try {
      const file = path.join(dir, "exhausted.json");
      writeFileSync(file, JSON.stringify({ version: 1, accounts: { acc3: "2026-11-24T12:54:57.934Z" } }));
      expect(readExhausted(file, new Date("2026-11-24T08:24:00Z")).size).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("shareConversations", () => {
  it("migrates added account conversations into the shared store without overwriting existing entries", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agy-share-"));
    try {
      const paths: PoolPaths = {
        agyStateDir: path.join(dir, "default"),
        accountsRoot: path.join(dir, "accounts"),
        bindingsFile: path.join(dir, "state", "bindings.json"),
      };
      const altDir = path.join(paths.accountsRoot, "alt");
      mkdirSync(path.join(paths.agyStateDir, "conversations"), { recursive: true });
      mkdirSync(path.join(altDir, "conversations"), { recursive: true });
      writeFileSync(path.join(paths.agyStateDir, "conversations", "keep.db"), "store-copy");
      writeFileSync(path.join(altDir, "conversations", "keep.db"), "alt-copy");
      writeFileSync(path.join(altDir, "conversations", "move.db"), "moved-copy");

      shareConversations(paths, { name: "alt" as AccountName, dir: altDir, disabled: false, disabledReason: null, egress: { kind: "direct" } });
      expect(readFileSync(path.join(paths.agyStateDir, "conversations", "keep.db"), "utf8")).toBe("store-copy");
      expect(readFileSync(path.join(paths.agyStateDir, "conversations", "move.db"), "utf8")).toBe("moved-copy");
      expect(existsSync(path.join(altDir, "conversations", "move.db"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("agy-pool ACP relay failover", () => {
  let root: string;
  let home: string;
  let logFile: string;
  let children: ChildProcess[];

  const stateDir = () => path.join(home, ".gemini", "antigravity-cli");
  const accountDir = (name: string) => path.join(home, ".local", "share", "agy-accounts", name);
  const statePath = (file: string) => path.join(home, ".local", "state", "agy-pool", file);

  function setupAccount(dir: string, opts: { label?: string; gemini5h: number; acpMode?: string }) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "antigravity-oauth-token"), "{}");
    writeFileSync(path.join(dir, "fake-usage.json"), usageJson(opts.gemini5h));
    if (opts.label) writeFileSync(path.join(dir, "fake-name"), opts.label);
    if (opts.acpMode) writeFileSync(path.join(dir, "fake-acp-mode"), opts.acpMode);
  }

  function startRelay(threadId: string) {
    const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("BB_") && !k.startsWith("AGY_")));
    const child = spawn(launcher, ["acp"], {
      env: {
        ...base,
        HOME: home,
        BB_THREAD_ID: threadId,
        BB_ANTIGRAVITY_EXECUTABLE: fakeBin,
        AGY_FAKE_ACP_LOG: logFile,
      } as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    const messages: any[] = [];
    const waiters: Array<(msg: any) => void> = [];
    let stderr = "";
    child.stderr!.on("data", (d) => (stderr += String(d)));
    readline.createInterface({ input: child.stdout!, crlfDelay: Infinity }).on("line", (line) => {
      if (!line.trim()) return;
      const msg = JSON.parse(line);
      messages.push(msg);
      const next = waiters.shift();
      if (next) next(msg);
    });
    const send = (obj: Record<string, unknown>) => child.stdin!.write(`${JSON.stringify(obj)}\n`);
    const nextMatching = async (pred: (m: any) => boolean) => {
      let idx = 0;
      while (true) {
        while (idx < messages.length) {
          if (pred(messages[idx])) return messages[idx];
          idx++;
        }
        await new Promise<void>((resolve) => waiters.push(() => resolve()));
      }
    };
    return { child, messages, send, nextMatching, getStderr: () => stderr };
  }

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "agy-relay-"));
    home = path.join(root, "home");
    logFile = path.join(root, "acp.log");
    children = [];
  });

  afterEach(() => {
    for (const child of children) {
      try {
        child.kill("SIGKILL");
      } catch {}
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("transparently swaps to another account on quota refusal, replays settings, and preserves the session", async () => {
    setupAccount(stateDir(), { gemini5h: 0.4, acpMode: "ok" });
    setupAccount(accountDir("alt"), { label: "alt", gemini5h: 0.9, acpMode: "quota" });

    const r = startRelay("thr_swap_1");
    r.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
    await r.nextMatching((m) => m.id === 1);

    r.send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/tmp", mcpServers: [] } });
    const created = await r.nextMatching((m) => m.id === 2);
    const sid = created.result.sessionId;

    r.send({ jsonrpc: "2.0", id: 3, method: "session/set_model", params: { sessionId: sid, modelId: "gemini-4-neon-high" } });
    await r.nextMatching((m) => m.id === 3);

    r.send({ jsonrpc: "2.0", id: 4, method: "session/prompt", params: { sessionId: sid, prompt: [{ type: "text", text: "Hello!" }] } });
    const done = await r.nextMatching((m) => m.id === 4);
    expect(done.result.stopReason).toBe("end_turn");

    const chunks = r.messages
      .filter((m) => m.method === "session/update" && m.params?.update?.sessionUpdate === "agent_message_chunk")
      .map((m) => m.params.update.content.text);
    expect(chunks).toEqual(["ANSWER(default):Hello!"]);

    const bindings = JSON.parse(readFileSync(statePath("bindings.json"), "utf8"));
    expect(bindings.threads.thr_swap_1.account).toBe("default");
    const exhausted = JSON.parse(readFileSync(statePath("exhausted.json"), "utf8"));
    expect(Object.keys(exhausted.accounts.alt)).toEqual(["gemini"]);

    const logEntries = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(logEntries.some((e) => e.account === "default" && e.method === "session/load" && e.params.sessionId === sid)).toBe(true);
    expect(logEntries.some((e) => e.account === "default" && e.method === "session/set_model")).toBe(true);
  });

  it("sends a continuation prompt when quota hits mid-turn after output", async () => {
    setupAccount(stateDir(), { gemini5h: 0.4, acpMode: "ok" });
    setupAccount(accountDir("alt"), { label: "alt", gemini5h: 0.9, acpMode: "midturn-quota" });

    const r = startRelay("thr_swap_mid");
    r.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
    await r.nextMatching((m) => m.id === 1);
    r.send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/tmp", mcpServers: [] } });
    const sid = (await r.nextMatching((m) => m.id === 2)).result.sessionId;
    r.send({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId: sid, prompt: [{ type: "text", text: "Do work" }] } });
    await r.nextMatching((m) => m.id === 3);

    const chunks = r.messages
      .filter((m) => m.method === "session/update" && m.params?.update?.sessionUpdate === "agent_message_chunk")
      .map((m) => m.params.update.content.text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("ANSWER(default):The previous reply was cut off by an account quota limit");
  });

  it("swaps on JSON-RPC quota error responses too", async () => {
    setupAccount(stateDir(), { gemini5h: 0.4, acpMode: "ok" });
    setupAccount(accountDir("alt"), { label: "alt", gemini5h: 0.9, acpMode: "rpc-quota-error" });

    const r = startRelay("thr_swap_rpc");
    r.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
    await r.nextMatching((m) => m.id === 1);
    r.send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/tmp", mcpServers: [] } });
    const sid = (await r.nextMatching((m) => m.id === 2)).result.sessionId;
    r.send({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId: sid, prompt: [{ type: "text", text: "Ping" }] } });
    const done = await r.nextMatching((m) => m.id === 3);
    expect(done.result.stopReason).toBe("end_turn");

    const chunks = r.messages
      .filter((m) => m.method === "session/update" && m.params?.update?.sessionUpdate === "agent_message_chunk")
      .map((m) => m.params.update.content.text);
    expect(chunks).toEqual(["ANSWER(default):Ping"]);
  });

  it("does not swap when an agent merely mentions quota reached in normal prose", async () => {
    setupAccount(stateDir(), { gemini5h: 0.4, acpMode: "ok" });
    setupAccount(accountDir("alt"), { label: "alt", gemini5h: 0.9, acpMode: "prose-mention" });

    const r = startRelay("thr_no_false_swap");
    r.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
    await r.nextMatching((m) => m.id === 1);
    r.send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/tmp", mcpServers: [] } });
    const sid = (await r.nextMatching((m) => m.id === 2)).result.sessionId;
    r.send({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId: sid, prompt: [{ type: "text", text: "Explain" }] } });
    await r.nextMatching((m) => m.id === 3);

    const bindings = JSON.parse(readFileSync(statePath("bindings.json"), "utf8"));
    expect(bindings.threads.thr_no_false_swap.account).toBe("alt");
    expect(existsSync(statePath("exhausted.json"))).toBe(false);
  });

  it("fails the prompt with the pool's exhaustion message when every account is out of quota", async () => {
    setupAccount(stateDir(), { gemini5h: 0.4, acpMode: "quota" });
    setupAccount(accountDir("alt"), { label: "alt", gemini5h: 0.9, acpMode: "quota" });

    const r = startRelay("thr_all_out");
    r.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
    await r.nextMatching((m) => m.id === 1);
    r.send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/tmp", mcpServers: [] } });
    const sid = (await r.nextMatching((m) => m.id === 2)).result.sessionId;
    r.send({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId: sid, prompt: [{ type: "text", text: "Hi" }] } });
    const done = await r.nextMatching((m) => m.id === 3);
    expect(done.result).toBeUndefined();
    expect(done.error.message).toMatch(
      /^agy-pool: every Antigravity account is out of Gemini quota\. The nearest reset is \S+Z \(account "(default|alt)"\)\.$/,
    );

    const chunks = r.messages
      .filter((m) => m.method === "session/update" && m.params?.update?.sessionUpdate === "agent_message_chunk")
      .map((m) => m.params.update.content.text);
    expect(chunks.join("")).not.toContain("quota reached");
  });

  it("names the refusing account and the new account's error when the session cannot move", async () => {
    setupAccount(stateDir(), { gemini5h: 0.4, acpMode: "load-error" });
    setupAccount(accountDir("alt"), { label: "alt", gemini5h: 0.9, acpMode: "quota" });

    const r = startRelay("thr_load_fails");
    r.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
    await r.nextMatching((m) => m.id === 1);
    r.send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/tmp", mcpServers: [] } });
    const sid = (await r.nextMatching((m) => m.id === 2)).result.sessionId;
    r.send({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId: sid, prompt: [{ type: "text", text: "Hi" }] } });
    const done = await r.nextMatching((m) => m.id === 3);
    expect(done.error.message).toBe(
      'agy-pool: account "alt" is out of Gemini quota; moving the session to "default" failed at session/load: conversation store is locked',
    );
  });

  async function openSession(r: ReturnType<typeof startRelay>, model?: string): Promise<string> {
    r.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
    await r.nextMatching((m) => m.id === 1);
    r.send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/tmp", mcpServers: [] } });
    const sid = (await r.nextMatching((m) => m.id === 2)).result.sessionId;
    if (model !== undefined) {
      r.send({ jsonrpc: "2.0", id: 3, method: "session/set_model", params: { sessionId: sid, modelId: model } });
      await r.nextMatching((m) => m.id === 3);
    }
    return sid;
  }

  async function ask(r: ReturnType<typeof startRelay>, sid: string, text: string): Promise<string> {
    r.send({ jsonrpc: "2.0", id: 4, method: "session/prompt", params: { sessionId: sid, prompt: [{ type: "text", text }] } });
    const done = await r.nextMatching((m) => m.id === 4);
    if (done.error !== undefined) return `ERROR:${done.error.message}`;
    return r.messages
      .filter((m) => m.method === "session/update" && m.params?.update?.sessionUpdate === "agent_message_chunk")
      .map((m) => m.params.update.content.text)
      .join("");
  }

  it("keeps Gemini threads running when every account is out of Claude/GPT quota", async () => {
    setupAccount(stateDir(), { gemini5h: 0.4, acpMode: "quota-3p" });
    setupAccount(accountDir("alt"), { label: "alt", gemini5h: 0.9, acpMode: "quota-3p" });

    const claude = startRelay("thr_claude");
    expect(await ask(claude, await openSession(claude, "claude-opus-5-5-medium"), "Hi")).toMatch(
      /^ERROR:agy-pool: every Antigravity account is out of Claude\/GPT quota\. The nearest reset is /,
    );
    const marks = JSON.parse(readFileSync(statePath("exhausted.json"), "utf8")).accounts;
    expect(Object.keys(marks).sort()).toEqual(["alt", "default"]);
    expect(Object.values(marks).map((families) => Object.keys(families as object))).toEqual([["3p"], ["3p"]]);

    const gemini = startRelay("thr_gemini");
    expect(await ask(gemini, await openSession(gemini), "Hi")).toBe("ANSWER(alt):Hi");
  });

  it("moves a prompt off an account already out of its family before sending it, and leaves other families there", async () => {
    setupAccount(stateDir(), { gemini5h: 0.4, acpMode: "ok" });
    setupAccount(accountDir("alt"), { label: "alt", gemini5h: 0.9, acpMode: "quota" });
    markExhausted(statePath("exhausted.json"), parseAccountName("alt")!, "3p", new Date(Date.now() + 3_600_000));

    const claude = startRelay("thr_claude_pre");
    expect(await ask(claude, await openSession(claude, "claude-sonnet-5-5-high"), "Go")).toBe("ANSWER(default):Go");
    const log = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(log.some((e) => e.account === "alt" && e.method === "session/prompt")).toBe(false);
    expect(JSON.parse(readFileSync(statePath("bindings.json"), "utf8")).threads.thr_claude_pre.account).toBe("default");

    const gemini = startRelay("thr_gemini_stays");
    await openSession(gemini, "gemini-4-hydrogen-high");
    expect(JSON.parse(readFileSync(statePath("bindings.json"), "utf8")).threads.thr_gemini_stays.account).toBe("alt");
  });

  it("moves off a refusing account even when agy never named the session's model", async () => {
    setupAccount(stateDir(), { gemini5h: 0.4, acpMode: "ok" });
    setupAccount(accountDir("alt"), { label: "alt", gemini5h: 0.9, acpMode: "quota" });
    for (const dir of [stateDir(), accountDir("alt")]) writeFileSync(path.join(dir, "fake-no-model"), "");

    const r = startRelay("thr_unknown_model");
    expect(await ask(r, await openSession(r), "Hi")).toBe("ANSWER(default):Hi");
    expect(existsSync(statePath("exhausted.json"))).toBe(false);
  });

  it("tries every other account before giving up when the model is unknown", async () => {
    setupAccount(stateDir(), { gemini5h: 0.4, acpMode: "ok" });
    setupAccount(accountDir("alt"), { label: "alt", gemini5h: 0.9, acpMode: "quota" });
    setupAccount(accountDir("acc3"), { label: "acc3", gemini5h: 0.8, acpMode: "quota" });
    for (const dir of [stateDir(), accountDir("alt"), accountDir("acc3")]) writeFileSync(path.join(dir, "fake-no-model"), "");

    const r = startRelay("thr_unknown_three");
    expect(await ask(r, await openSession(r), "Hi")).toBe("ANSWER(default):Hi");
  });

  it("answers the prompt with an error and exits when the account it moves to dies", async () => {
    setupAccount(stateDir(), { gemini5h: 0.4, acpMode: "crash-on-init" });
    setupAccount(accountDir("alt"), { label: "alt", gemini5h: 0.9, acpMode: "ok" });
    markExhausted(statePath("exhausted.json"), parseAccountName("alt")!, "3p", new Date(Date.now() + 3_600_000));

    const r = startRelay("thr_dies_on_move");
    const exited = new Promise<number | null>((resolve) => r.child.once("exit", resolve));
    const sid = await openSession(r, "claude-opus-5-5-high");
    r.send({ jsonrpc: "2.0", id: 4, method: "session/prompt", params: { sessionId: sid, prompt: [{ type: "text", text: "Go" }] } });
    expect((await r.nextMatching((m) => m.id === 4)).error.message).toContain("agy exited");
    expect(await exited).toBe(1);
  });

  it("follows a model chosen through session/set_config_option", async () => {
    setupAccount(stateDir(), { gemini5h: 0.4, acpMode: "ok" });
    setupAccount(accountDir("alt"), { label: "alt", gemini5h: 0.9, acpMode: "quota-3p" });
    markExhausted(statePath("exhausted.json"), parseAccountName("alt")!, "3p", new Date(Date.now() + 3_600_000));

    const r = startRelay("thr_config_option");
    const sid = await openSession(r);
    r.send({ jsonrpc: "2.0", id: 3, method: "session/set_config_option", params: { sessionId: sid, configId: "model", value: "claude-opus-5-5-high" } });
    await r.nextMatching((m) => m.id === 3);
    expect(await ask(r, sid, "Go")).toBe("ANSWER(default):Go");
  });

  it("still moves a thread off the refused account when a relay started before families calls resolve", async () => {
    setupAccount(stateDir(), { gemini5h: 0.4, acpMode: "ok" });
    setupAccount(accountDir("alt"), { label: "alt", gemini5h: 0.9, acpMode: "ok" });
    const first = startRelay("thr_old_relay");
    await openSession(first);
    expect(JSON.parse(readFileSync(statePath("bindings.json"), "utf8")).threads.thr_old_relay.account).toBe("alt");

    const cli = fileURLToPath(new URL("../src/pool/cli.ts", import.meta.url));
    const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("BB_") && !k.startsWith("AGY_")));
    const run = spawnSync(process.execPath, [cli, "resolve", String(process.pid), "alt", "60000"], {
      env: { ...base, HOME: home, BB_THREAD_ID: "thr_old_relay", BB_ANTIGRAVITY_EXECUTABLE: fakeBin },
      encoding: "utf8",
    });
    expect(run.stdout).toContain("AGY_POOL_RESOLVED=default");
    expect(existsSync(statePath("exhausted.json"))).toBe(false);
  });

  it("compacts oversized available_commands_update payloads below BB's 64 KiB limit while keeping every command", async () => {
    setupAccount(stateDir(), { gemini5h: 0.9, acpMode: "large-commands" });

    const r = startRelay("thr_large_cmds");
    r.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
    await r.nextMatching((m) => m.id === 1);
    r.send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/tmp", mcpServers: [] } });
    await r.nextMatching((m) => m.id === 2);
    const update = await r.nextMatching(
      (m) => m.method === "session/update" && m.params?.update?.sessionUpdate === "available_commands_update",
    );
    const commands = update.params.update.availableCommands;
    expect(commands).toHaveLength(400);
    expect(commands[0].name).toBe("goal");
    expect(providerCommandsPayloadBytes(commands)).toBeLessThanOrEqual(MAX_PROVIDER_COMMANDS_BYTES);
    expect(providerCommandsPayloadBytes(commands)).toBeLessThan(65_536);
  });
});

describe("fitAvailableCommands", () => {
  it("passes small command lists through unchanged", () => {
    const cmds = [
      { name: "goal", description: "Run until done." },
      { name: "plan", description: "Plan before coding." },
    ];
    expect(fitAvailableCommands(cmds)).toBe(cmds);
    const msg = {
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "s", update: { sessionUpdate: "available_commands_update", availableCommands: cmds } },
    };
    const rawLine = JSON.stringify(msg);
    expect(fitAvailableCommandsLine(rawLine, msg)).toBe(rawLine);
  });

  it("truncates descriptions to keep all commands inside the byte budget", () => {
    const cmds = Array.from({ length: 400 }, (_, i) => ({
      name: `skill-${i}`,
      description: `Detailed explanation for skill ${i}: ${"кириллица ".repeat(25)}`,
    }));
    expect(providerCommandsPayloadBytes(cmds)).toBeGreaterThan(65_536);
    const fitted = fitAvailableCommands(cmds, MAX_PROVIDER_COMMANDS_BYTES);
    expect(fitted).toHaveLength(400);
    expect(providerCommandsPayloadBytes(fitted)).toBeLessThanOrEqual(MAX_PROVIDER_COMMANDS_BYTES);
    expect(String(fitted[0]!.description)).toMatch(/…$/);
  });

  it("trims the tail when even empty descriptions exceed the budget", () => {
    const cmds = Array.from({ length: 450 }, (_, i) => ({
      name: `very-long-command-name-${String(i).padStart(4, "0")}`,
      description: "desc",
    }));
    const fitted = fitAvailableCommands(cmds, 2_000);
    expect(fitted.length).toBeGreaterThan(0);
    expect(fitted.length).toBeLessThan(cmds.length);
    expect(providerCommandsPayloadBytes(fitted)).toBeLessThanOrEqual(2_000);
  });
});
