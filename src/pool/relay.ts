// The pool launcher's process. It starts agy on the thread's account and,
// for `agy acp`, relays ACP between bb and agy line by line. When agy answers
// a prompt with its quota refusal, the relay hides that turn, marks the
// account exhausted until the reset agy named, starts agy on another account,
// reopens every session from the shared conversation store and sends the
// prompt again, so bb sees one uninterrupted turn. Quota is tracked per model
// family: a refusal for Claude/GPT leaves the account open to Gemini, and a
// prompt whose family is already known to be out on this account moves before
// it is sent.
import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

type RelayChild = ChildProcessByStdio<Writable, Readable, null>;
import { parseAccountName, poolPaths, type AccountName } from "./account.ts";
import { fitAvailableCommandsLine } from "./commands.ts";
import { QUOTA_MESSAGE, exhaustedUntil, exhaustionFile, isQuotaError, quotaResetMs, readExhausted } from "./exhaustion.ts";
import { modelFamily, type ModelFamily } from "./family.ts";

type Message = {
  readonly id?: string | number | null;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly result?: Record<string, unknown>;
  readonly error?: unknown;
};

type Launch = {
  readonly account: AccountName | null;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
};

type Refusal = {
  text: string;
  readonly lines: string[];
};

type Prompt = {
  readonly message: Message;
  readonly sessionId: string;
  /** The model family the session used when the prompt was sent; null before agy named a model. */
  readonly family: ModelFamily | null;
  /** agy already streamed output or tool calls for this turn. */
  produced: boolean;
  /** agy's quota refusal and every line after it, held back from bb. */
  refusal: Refusal | null;
  /** Number of account swaps already performed for this prompt. */
  swaps: number;
};

const CONTINUE_PROMPT =
  "The previous reply was cut off by an account quota limit and the session moved to another account. Continue the task from where it stopped.";
const OUTPUT_UPDATES = new Set(["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update", "plan"]);
const MAX_SWAPS = 10;

const paths = poolPaths(process.env, os.homedir());
const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
const lockFile = path.join(path.dirname(paths.bindingsFile), "bindings.lock");
const marksFile = exhaustionFile(paths.bindingsFile);
const passArgs = process.argv.slice(2);

const idKey = (id: Message["id"]) => JSON.stringify(id ?? null);

function parse(line: string): Message | null {
  try {
    const value: unknown = JSON.parse(line);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Message) : null;
  } catch {
    return null;
  }
}

/** Runs the pool's account choice for `family` (and optional exhaustion mark) under bindings.lock; null when no account can start. */
function resolveLaunch(family: ModelFamily | null, exhaust?: { readonly account: AccountName; readonly resetMs: number }): Launch | null {
  mkdirSync(path.dirname(lockFile), { recursive: true });
  const args = [lockFile, process.execPath, cli, "resolve", String(process.pid)];
  if (family !== null) {
    args.push(family);
    if (exhaust !== undefined) args.push(exhaust.account, String(Math.round(exhaust.resetMs)));
  }
  const run = spawnSync("flock", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (run.status !== 0) return null;
  const lines = run.stdout.split("\n");
  const split = lines.indexOf("--");
  if (split < 0) return null;
  const env = Object.fromEntries(lines.slice(0, split).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
  const [command, ...cmdArgs] = lines.slice(split + 1);
  return { account: parseAccountName(env.AGY_POOL_RESOLVED ?? ""), command: command!, args: cmdArgs, env };
}

function start(launch: Launch): RelayChild {
  // Own process group, so a swap can stop agy inside bwrap without touching the relay.
  return spawn(launch.command, [...launch.args, ...passArgs], {
    env: { ...process.env, ...launch.env },
    stdio: ["pipe", "pipe", "inherit"],
    detached: true,
  });
}

function stop(child: RelayChild, signal: NodeJS.Signals = "SIGTERM"): void {
  child.stdin.end();
  try {
    process.kill(-child.pid!, signal);
  } catch {}
  if (signal !== "SIGKILL") {
    setTimeout(() => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {}
    }, 3_000).unref();
  }
}

const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

class Relay {
  private child!: RelayChild;
  private account: AccountName | null = null;
  private initialize: Message | null = null;
  private readonly opening = new Map<string, Record<string, unknown>>();
  private readonly sessions = new Map<string, Record<string, unknown>>();
  /** The model each session runs, from agy's session answers and bb's model choice. */
  private readonly models = new Map<string, string>();
  private readonly settings = new Map<string, Map<string, Message>>();
  private readonly prompts = new Map<string, Prompt>();
  private readonly internal = new Map<string, (message: Message) => void>();
  private readonly loading = new Set<string>();
  private swapping: string[] | null = null;
  private nextId = 0;
  private stopping = false;

  run(launch: Launch): void {
    this.attach(launch);
    readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => this.fromClient(line));
    process.stdin.on("end", () => this.child.stdin.end());
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const)
      process.on(signal, () => {
        this.stopping = true;
        stop(this.child, signal);
        setTimeout(() => process.exit(143), 10_000).unref();
      });
  }

  private attach(launch: Launch): void {
    const child = start(launch);
    this.child = child;
    this.account = launch.account;
    readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
      if (child === this.child) this.fromAgent(line);
    });
    child.on("exit", (code, signal) => {
      if (child !== this.child) return;
      if (this.swapping !== null) {
        for (const [key, waiter] of this.internal) {
          this.internal.delete(key);
          waiter({ error: { code: -1, message: "agy exited during account swap" } });
        }
        return;
      }
      process.exitCode = code ?? (this.stopping ? 0 : signal ? 128 + (os.constants.signals[signal] ?? 0) : 1);
      process.stdout.end();
      setTimeout(() => process.exit(), 100).unref();
    });
  }

  private fromClient(line: string): void {
    if (this.swapping !== null) {
      this.swapping.push(line);
      return;
    }
    const message = parse(line);
    if (message?.method !== undefined && message.id !== undefined) {
      const prompt = this.track(message);
      if (prompt && this.outOfQuota(prompt.family)) return void this.swap(prompt, null);
    }
    this.child.stdin.write(`${line}\n`);
  }

  /** Another thread already found this account out of `family` quota. */
  private outOfQuota(family: ModelFamily | null): boolean {
    return (
      family !== null && this.account !== null && exhaustedUntil(readExhausted(marksFile, new Date()), this.account, family) !== undefined
    );
  }

  private track(message: Message): Prompt | null {
    const params = message.params ?? {};
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : null;
    if (message.method === "initialize") this.initialize = message;
    else if (message.method === "session/new") this.opening.set(idKey(message.id), params);
    else if ((message.method === "session/load" || message.method === "session/resume") && sessionId) {
      this.sessions.set(sessionId, params);
      this.opening.set(idKey(message.id), params);
    } else if (message.method?.startsWith("session/set_") && sessionId) {
      const key = `${message.method}:${String(params.configId ?? "")}`;
      this.settings.set(sessionId, (this.settings.get(sessionId) ?? new Map()).set(key, message));
      const model = message.method === "session/set_model" ? params.modelId : params.configId === "model" ? params.value : undefined;
      if (typeof model === "string") this.models.set(sessionId, model);
    } else if (message.method === "session/prompt" && sessionId) {
      const model = this.models.get(sessionId);
      const prompt = { message, sessionId, family: model === undefined ? null : modelFamily(model), produced: false, refusal: null, swaps: 0 };
      this.prompts.set(idKey(message.id), prompt);
      return prompt;
    }
    return null;
  }

  private fromAgent(line: string): void {
    const message = parse(line);
    if (message === null) return out(line);
    const key = idKey(message.id);
    if (message.method === undefined && message.id !== undefined) {
      const waiter = this.internal.get(key);
      if (waiter) {
        this.internal.delete(key);
        return waiter(message);
      }
      const opened = this.opening.get(key);
      if (opened) {
        this.opening.delete(key);
        const sessionId = message.result?.sessionId ?? opened.sessionId;
        if (typeof sessionId === "string") {
          this.sessions.set(sessionId, opened);
          const current = (message.result?.models as { currentModelId?: unknown } | undefined)?.currentModelId;
          if (typeof current === "string" && !this.models.has(sessionId)) this.models.set(sessionId, current);
        }
      }
      const prompt = this.prompts.get(key);
      if (prompt) {
        this.prompts.delete(key);
        if (prompt.refusal) return void this.swap(prompt, line);
        if (message.error !== undefined) {
          const errorText = JSON.stringify(message.error);
          if (isQuotaError(errorText)) {
            prompt.refusal = { text: errorText, lines: [] };
            return void this.swap(prompt, line);
          }
        }
      }
      return out(line);
    }
    if (message.method === "session/update") {
      const sessionId = message.params?.sessionId;
      if (typeof sessionId === "string" && this.loading.has(sessionId)) return;
      const prompt = [...this.prompts.values()].find((candidate) => candidate.sessionId === sessionId);
      if (prompt) {
        const update = (message.params?.update ?? {}) as { sessionUpdate?: string; content?: { text?: unknown } };
        const text = typeof update.content?.text === "string" ? update.content.text : "";
        if (prompt.refusal) {
          prompt.refusal.lines.push(line);
          if (update.sessionUpdate === "agent_message_chunk") prompt.refusal.text += text;
          return;
        }
        if (update.sessionUpdate === "agent_message_chunk" && QUOTA_MESSAGE.test(text)) {
          prompt.refusal = { text, lines: [line] };
          return;
        }
        if (OUTPUT_UPDATES.has(update.sessionUpdate ?? "")) prompt.produced = true;
      }
      return out(fitAvailableCommandsLine(line, message));
    }
    out(line);
  }

  private request(method: string, params: unknown): Promise<Message> {
    const id = `agy-pool-${++this.nextId}`;
    return new Promise((resolve) => {
      this.internal.set(idKey(id), resolve);
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  /**
   * Moves the session to another account and sends the prompt there. `response`
   * is agy's answer to a refused prompt, or null when the prompt moves before
   * it was sent because its family is already out on this account.
   */
  private async swap(prompt: Prompt, response: string | null): Promise<void> {
    const buffered: string[] = [];
    this.swapping = buffered;
    const giveUp = () => {
      if (response === null) this.child.stdin.write(`${JSON.stringify(prompt.message)}\n`);
      else for (const line of [...prompt.refusal!.lines, response]) out(line);
    };
    try {
      if (prompt.swaps >= MAX_SWAPS) return giveUp();
      const exhaust =
        this.account !== null && prompt.refusal !== null
          ? { account: this.account, resetMs: quotaResetMs(prompt.refusal.text) }
          : undefined;
      const next = this.initialize === null ? null : resolveLaunch(prompt.family, exhaust);
      if (next === null || next.account === this.account) return giveUp();
      const scope = prompt.family === null ? "quota" : `${prompt.family} quota`;
      process.stderr.write(`agy-pool: account "${this.account}" is out of ${scope}; moving to "${next.account}".\n`);
      const previous = this.child;
      this.attach(next);
      stop(previous);
      const ready = await this.request("initialize", this.initialize!.params);
      if (ready.error) return giveUp();
      for (const [sessionId, params] of this.sessions) {
        this.loading.add(sessionId);
        const loaded = await this.request("session/load", { ...params, sessionId });
        this.loading.delete(sessionId);
        if (loaded.error) return giveUp();
        for (const setting of this.settings.get(sessionId)?.values() ?? []) await this.request(setting.method!, setting.params);
      }
      const message = prompt.produced
        ? { ...prompt.message, params: { ...prompt.message.params, prompt: [{ type: "text", text: CONTINUE_PROMPT }] } }
        : prompt.message;
      this.prompts.set(idKey(message.id), {
        message,
        sessionId: prompt.sessionId,
        family: prompt.family,
        produced: false,
        refusal: null,
        swaps: prompt.swaps + 1,
      });
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    } finally {
      this.swapping = null;
      for (const line of buffered) this.fromClient(line);
    }
  }
}

const launch = resolveLaunch(null);
if (launch === null) process.exit(1);
if (passArgs[0] === "acp") new Relay().run(launch);
else {
  const child = spawn(launch.command, [...launch.args, ...passArgs], { env: { ...process.env, ...launch.env }, stdio: "inherit" });
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => child.kill(signal));
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : 1)));
}
