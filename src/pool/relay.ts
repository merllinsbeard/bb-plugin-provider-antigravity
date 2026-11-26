// The pool launcher's process. It starts agy on the thread's account and,
// for `agy acp`, relays ACP between bb and agy line by line. When agy answers
// a prompt with its quota refusal, the relay hides that turn, marks the
// account exhausted until the reset agy named, starts agy on another account,
// reopens every session from the shared conversation store and sends the
// prompt again, so bb sees one uninterrupted turn. Quota is tracked per model
// family: a refusal for Claude/GPT leaves the account open to Gemini, and a
// prompt whose family is already known to be out on this account moves before
// it is sent. When no account can take a refused prompt, the relay answers it
// with a JSON-RPC error carrying the pool's reason, so bb fails the turn instead
// of recording agy's refusal as a reply. A thread starts before its model is
// known, so right before the first prompt of a brand-new session the relay asks
// the pool again for that model's family and, when another account suits it
// better, moves the still-empty session there; after that the thread stays put.
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
import { familyLabel, modelFamily, type ModelFamily } from "./family.ts";

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

/** The pool's account choice, or the reason no account can start (the message `cli.ts resolve` printed). */
type Resolution = { readonly ok: true; readonly launch: Launch } | { readonly ok: false; readonly message: string };

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
  /** Accounts that refused this prompt, newest first, so a swap never returns to one of them. */
  readonly refusedBy: readonly AccountName[];
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

/**
 * Runs the pool's account choice for `family` (and optional exhaustion mark) under bindings.lock.
 * A one-shot run (`agy -p` and other non-ACP calls) is picked like a new thread but bound to nothing.
 * A rebalance picks afresh for `family` although the thread is bound.
 */
function resolveLaunch(
  family: ModelFamily | null,
  exhaust?: { readonly accounts: readonly AccountName[]; readonly resetMs: number },
  { oneShot = false, rebalance = false }: { readonly oneShot?: boolean; readonly rebalance?: boolean } = {},
): Resolution {
  mkdirSync(path.dirname(lockFile), { recursive: true });
  const args = [lockFile, process.execPath, cli, "resolve", String(process.pid)];
  if (exhaust !== undefined || family !== null)
    args.push(exhaust?.accounts.join(",") || "-", String(Math.round(exhaust?.resetMs ?? 0)), ...(family === null ? [] : [family]));
  // Flags left in the caller's environment must not change how this launch is picked.
  const { AGY_POOL_ONE_SHOT: _oneShot, AGY_POOL_REBALANCE: _rebalance, ...callerEnv } = process.env;
  const run = spawnSync("flock", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...callerEnv, ...(oneShot ? { AGY_POOL_ONE_SHOT: "1" } : {}), ...(rebalance ? { AGY_POOL_REBALANCE: "1" } : {}) },
  });
  // bb shows the launcher's stderr when the agent exits, so the pool's own lines still go there.
  const stderr = run.stderr ?? "";
  process.stderr.write(stderr);
  const failed = (): Resolution => ({ ok: false, message: stderr.trim() || "agy-pool: no Antigravity account could start." });
  if (run.status !== 0) return failed();
  const lines = run.stdout.split("\n");
  const split = lines.indexOf("--");
  if (split < 0) return failed();
  const env = Object.fromEntries(lines.slice(0, split).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
  const [command, ...cmdArgs] = lines.slice(split + 1);
  return { ok: true, launch: { account: parseAccountName(env.AGY_POOL_RESOLVED ?? ""), command: command!, args: cmdArgs, env } };
}

function start(launch: Launch): RelayChild {
  // Own process group, so a swap can stop agy inside bwrap without touching the relay.
  const child = spawn(launch.command, [...launch.args, ...passArgs], {
    env: { ...process.env, ...launch.env },
    stdio: ["pipe", "pipe", "inherit"],
    detached: true,
  });
  // A write to an agy that already exited must not crash the relay; its exit handler reports the end.
  child.stdin.on("error", () => {});
  return child;
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

/** The model agy reports for a session: the `model` config option, else the legacy `models` field. */
function sessionModel(result: Record<string, unknown>): string | null {
  const options = Array.isArray(result.configOptions) ? (result.configOptions as { id?: unknown; category?: unknown; currentValue?: unknown }[]) : [];
  const option = options.find((candidate) => candidate.id === "model" || candidate.category === "model");
  const current = option?.currentValue ?? (result.models as { currentModelId?: unknown } | undefined)?.currentModelId;
  return typeof current === "string" ? current : null;
}

/**
 * Whether the account still may change for a better fit: `provisional` until the
 * relay sends its first prompt or reopens an existing session. A reopened
 * session has history and a sent prompt has warmed agy's prompt cache on this
 * account, so from then on only a quota refusal moves the thread.
 */
type Placement = "provisional" | "settled";

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
  private placement: Placement = "provisional";
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
      this.finish(code ?? (this.stopping ? 0 : signal ? 128 + (os.constants.signals[signal] ?? 0) : 1));
    });
  }

  /** Ends the relay with agy's exit code, so bb sees the agent stop. */
  private finish(code: number): void {
    process.exitCode = code;
    process.stdout.end();
    setTimeout(() => process.exit(), 100).unref();
  }

  private fromClient(line: string): void {
    if (this.swapping !== null) {
      this.swapping.push(line);
      return;
    }
    const message = parse(line);
    if (message?.method !== undefined && message.id !== undefined) {
      const prompt = this.track(message);
      if (prompt) {
        const rebalance = this.mayRebalance(prompt);
        this.placement = "settled";
        if (this.outOfQuota(prompt.family)) return void this.swap(prompt, null);
        if (rebalance) return void this.swap(prompt, null, true);
      }
    }
    this.child.stdin.write(`${line}\n`);
  }

  /** Another thread already found this account out of `family` quota. */
  private outOfQuota(family: ModelFamily | null): boolean {
    return (
      family !== null && this.account !== null && exhaustedUntil(readExhausted(marksFile, new Date()), this.account, family) !== undefined
    );
  }

  /**
   * The first prompt of a session this relay created, with its model known, on a
   * pool-picked account: the start-time pick did not know the model, so ask again.
   */
  private mayRebalance(prompt: Prompt): boolean {
    return (
      this.placement === "provisional" &&
      prompt.family !== null &&
      this.sessions.has(prompt.sessionId) &&
      this.account !== null &&
      !process.env.AGY_POOL_ACCOUNT &&
      !!process.env.BB_THREAD_ID
    );
  }

  private track(message: Message): Prompt | null {
    const params = message.params ?? {};
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : null;
    if (message.method === "initialize") this.initialize = message;
    else if (message.method === "session/new") this.opening.set(idKey(message.id), params);
    else if ((message.method === "session/load" || message.method === "session/resume") && sessionId) {
      this.placement = "settled";
      this.sessions.set(sessionId, params);
      this.opening.set(idKey(message.id), params);
    } else if (message.method?.startsWith("session/set_") && sessionId) {
      const key = `${message.method}:${String(params.configId ?? "")}`;
      this.settings.set(sessionId, (this.settings.get(sessionId) ?? new Map()).set(key, message));
      const model = message.method === "session/set_model" ? params.modelId : params.configId === "model" ? params.value : undefined;
      if (typeof model === "string") this.models.set(sessionId, model);
    } else if (message.method === "session/prompt" && sessionId) {
      const model = this.models.get(sessionId);
      const prompt = {
        message,
        sessionId,
        family: model === undefined ? null : modelFamily(model),
        produced: false,
        refusal: null,
        swaps: 0,
        refusedBy: [],
      };
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
          const current = sessionModel(message.result ?? {});
          if (current !== null && !this.models.has(sessionId)) this.models.set(sessionId, current);
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

  /** Opens every session of this relay on the freshly attached agy and replays its settings. */
  private async reopen(): Promise<{ readonly step: string; readonly error: unknown } | null> {
    const ready = await this.request("initialize", this.initialize!.params);
    if (ready.error) return { step: "initialize", error: ready.error };
    for (const [sessionId, params] of this.sessions) {
      this.loading.add(sessionId);
      const loaded = await this.request("session/load", { ...params, sessionId });
      this.loading.delete(sessionId);
      if (loaded.error) return { step: "session/load", error: loaded.error };
      for (const setting of this.settings.get(sessionId)?.values() ?? []) await this.request(setting.method!, setting.params);
    }
    return null;
  }

  /**
   * Moves the session to another account and sends the prompt there. `response`
   * is agy's answer to a refused prompt, or null when the prompt moves before
   * it was sent: because its family is already out on this account, or, with
   * `rebalance`, because the pool finds a better account for the first prompt
   * of a new session. When the pool keeps this account, the prompt goes to the
   * running agy unchanged.
   */
  private async swap(prompt: Prompt, response: string | null, rebalance = false): Promise<void> {
    const buffered: string[] = [];
    this.swapping = buffered;
    const fail = (code: number, message: string) => out(JSON.stringify({ jsonrpc: "2.0", id: prompt.message.id, error: { code, message } }));
    // The account that refused; `attach` below replaces `this.account` with the one the swap moves to.
    const from = this.account;
    const outOf = prompt.family === null ? "quota" : `${familyLabel(prompt.family)} quota`;
    // Set once agy runs on the target account; from then on the prompt can no longer go to the agy that had the session.
    let moved = false;
    // `reason` says why the prompt could not move: the pool's answer, or the error the new account gave.
    const giveUp = (reason?: string) => {
      const alive = this.child.exitCode === null && this.child.signalCode === null;
      if (!alive) fail(-32603, "agy exited during account swap");
      // agy refused the prompt for quota and no account can take it, or the target could not open the session:
      // fail the turn rather than pass a refusal off as a reply or send the prompt to an agy without the session.
      else if (response !== null || moved)
        fail(-32000, reason ?? `agy-pool: account "${from}" is out of ${outOf} and the prompt could not move to another account.`);
      // The prompt has not been sent yet; agy itself decides whether the account still serves it.
      else this.child.stdin.write(`${JSON.stringify(prompt.message)}\n`);
      // The agy this swap started died; nothing is left to carry the session.
      if (!alive) this.finish(1);
    };
    try {
      if (prompt.swaps >= MAX_SWAPS) return giveUp();
      const refusedBy = this.account !== null && prompt.refusal !== null ? [this.account, ...prompt.refusedBy] : prompt.refusedBy;
      const exhaust =
        refusedBy.length > 0 ? { accounts: refusedBy, resetMs: prompt.refusal === null ? 0 : quotaResetMs(prompt.refusal.text) } : undefined;
      const resolved = this.initialize === null ? null : resolveLaunch(prompt.family, exhaust, { rebalance });
      if (resolved === null) return giveUp();
      if (!resolved.ok) return giveUp(resolved.message);
      const next = resolved.launch;
      if (next.account === this.account) return giveUp();
      const scope = prompt.family === null ? "quota" : `${prompt.family} quota`;
      process.stderr.write(
        rebalance
          ? `agy-pool: account "${next.account}" suits ${scope} better than "${this.account}"; moving the new session before its first prompt.\n`
          : `agy-pool: account "${this.account}" is out of ${scope}; moving to "${next.account}".\n`,
      );
      const previous = this.child;
      this.attach(next);
      // A rebalance keeps the start-time agy until the target holds the session, so a failed move costs nothing.
      if (rebalance) {
        const target = this.child;
        const stayed = (step: string, error: unknown) => {
          const detail = (error as { message?: unknown }).message;
          process.stderr.write(
            `agy-pool: moving the new session to "${next.account}" failed at ${step} (${typeof detail === "string" ? detail : JSON.stringify(error)}); it stays on "${from}".\n`,
          );
          this.child = previous;
          this.account = from;
          stop(target);
          return giveUp();
        };
        const failure = await this.reopen();
        if (failure) return stayed(failure.step, failure.error);
        stop(previous);
        this.child.stdin.write(`${JSON.stringify(prompt.message)}\n`);
        return;
      }
      moved = true;
      stop(previous);
      const moveFailed = (step: string, error: unknown) => {
        const detail = (error as { message?: unknown }).message;
        return `agy-pool: account "${from}" is out of ${outOf}; moving the session to "${next.account}" failed at ${step}: ${typeof detail === "string" ? detail : JSON.stringify(error)}`;
      };
      const failure = await this.reopen();
      if (failure) return giveUp(moveFailed(failure.step, failure.error));
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
        refusedBy,
      });
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    } finally {
      this.swapping = null;
      for (const line of buffered) this.fromClient(line);
    }
  }
}

/** The value of an agy flag such as `--model`, in the `--flag x` or `--flag=x` form. */
function flagValue(args: readonly string[], flag: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === flag) return args[i + 1];
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
  }
  return undefined;
}

/**
 * agy's print mode (`-p`, `--print`, `--prompt`) runs one turn and exits, so the
 * pool can hold its output and run it again elsewhere. A stream-json run talks
 * to its caller line by line (one turn per stdin message, events as they come),
 * so holding its output would stall the caller: it gets one run with agy's own stdio.
 */
function isRetryablePrint(args: readonly string[]): boolean {
  if (!args.some((arg) => /^(-p|--print|--prompt)(=|$)/.test(arg))) return false;
  return flagValue(args, "--input-format") !== "stream-json" && flagValue(args, "--output-format") !== "stream-json";
}

type Attempt = { readonly code: number; readonly stdout: string; readonly stderr: string };

let current: ReturnType<typeof spawn> | null = null;

const exitCode = (code: number | null, signal: NodeJS.Signals | null) => code ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : 1);

/** One print-mode run of agy: stderr streams through, stdout is held so a refused run never reaches the caller. */
function attempt(launch: Launch): Promise<Attempt> {
  return new Promise((resolve) => {
    const child = spawn(launch.command, [...launch.args, ...passArgs], {
      env: { ...process.env, ...launch.env },
      stdio: ["inherit", "pipe", "pipe"],
    });
    current = child;
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (chunk) => (stdout += chunk));
    child.stderr!.on("data", (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    child.on("close", (code, signal) => {
      current = null;
      resolve({ code: exitCode(code, signal), stdout, stderr });
    });
  });
}

/** Writes the held stdout, then exits with agy's code once the pipe took it. */
function finish(stdout: string, code: number): void {
  process.stdout.write(stdout, () => process.exit(code));
}

/**
 * A non-ACP call such as `agy -p`. It starts on the account with the most room
 * for the model's family and records no thread binding. In print mode, a run
 * agy refuses for quota marks that account until the reset agy named and runs
 * again on the next one; when no account is left, the last refusal and the
 * pool's reason (nearest reset) reach the caller.
 */
async function runOnce(): Promise<void> {
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const)
    process.on(signal, () => (current ? current.kill(signal) : process.exit(128 + os.constants.signals[signal])));
  const model = flagValue(passArgs, "--model");
  const family = model === undefined ? null : modelFamily(model);
  const print = isRetryablePrint(passArgs);
  const refused: AccountName[] = [];
  let exhaust: { readonly accounts: readonly AccountName[]; readonly resetMs: number } | undefined;
  let last: Attempt | null = null;
  for (;;) {
    const resolved = resolveLaunch(family, exhaust, { oneShot: true });
    if (!resolved.ok) {
      if (last) return finish(last.stdout, last.code || 1);
      process.exit(1);
    }
    const launch = resolved.launch;
    if (!print) {
      const child = spawn(launch.command, [...launch.args, ...passArgs], { env: { ...process.env, ...launch.env }, stdio: "inherit" });
      current = child;
      child.on("exit", (code, signal) => process.exit(exitCode(code, signal)));
      return;
    }
    const result = await attempt(launch);
    const text = `${result.stdout}\n${result.stderr}`;
    // An account forced with AGY_POOL_ACCOUNT is the caller's choice: its refusal goes back as is.
    const movable = launch.account !== null && !process.env.AGY_POOL_ACCOUNT && refused.length < MAX_SWAPS;
    if (result.code !== 0 && isQuotaError(text) && movable) {
      refused.unshift(launch.account!);
      // Only a refusal with agy's "Resets in" marks the account for every run and thread;
      // a short throttle (RESOURCE_EXHAUSTED without a reset) just moves this run.
      exhaust = { accounts: refused, resetMs: /Resets in/i.test(text) ? quotaResetMs(text) : 0 };
      last = result;
      const label = family === null ? "" : `${familyLabel(family)} `;
      process.stderr.write(`agy-pool: account "${launch.account}" is out of ${label}quota; running again on another account.\n`);
      continue;
    }
    return finish(result.stdout, result.code);
  }
}

if (passArgs[0] === "acp") {
  const resolved = resolveLaunch(null);
  if (!resolved.ok) process.exit(1);
  new Relay().run(resolved.launch);
} else await runOnce();
