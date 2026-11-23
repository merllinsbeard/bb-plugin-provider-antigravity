import { accessSync, constants } from "node:fs";
import path from "node:path";
import { sanitizeInheritedChildProcessEnv } from "@get-bb/plugin-sdk/provider-bridge";
import {
  experimental_hostToolchain,
  experimental_spawnHostProcess,
} from "@get-bb/plugin-sdk/process";
import { parseUsageJson, type ParseFailure } from "./print-reader.ts";
import type { Command } from "../pool/account.ts";
import type { ProbeFailure, ProbeOutcome } from "./types.ts";
import { toQuotaWindows } from "./windows.ts";

const USAGE_ARGS = ["-p", "/usage", "--output-format", "json", "--print-timeout", "15s"];
const KILL_AFTER_MS = 20_000;
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const STDERR_TAIL_CHARS = 64 * 1024;
const AUTH_REQUIRED = /authentication required/i;

export type PrintRun =
  | { readonly kind: "exited"; readonly code: number | null; readonly stdout: string; readonly stderr: string }
  | { readonly kind: "aborted-auth" }
  | { readonly kind: "timeout" }
  | { readonly kind: "output-too-large" }
  | { readonly kind: "spawn-failed"; readonly message: string };

export type ProbePorts = {
  readonly locateBinary: () => string | null;
  readonly hasAuthToken: () => boolean;
  readonly runPrint: (binary: string) => Promise<PrintRun>;
};

function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveAgyBinary(
  env: NodeJS.ProcessEnv,
  homeDir: string,
  resolveOnPath: (command: string) => string | null = (command) =>
    experimental_hostToolchain.resolve(command),
): string | null {
  const candidates = [
    () => env.BB_ANTIGRAVITY_EXECUTABLE || null,
    () => resolveOnPath("agy"),
    () => path.join(homeDir, ".local", "bin", "agy"),
  ];
  for (const candidate of candidates) {
    const file = candidate();
    if (file !== null && isExecutable(file)) return file;
  }
  return null;
}

export function createPrintRunner({
  killAfterMs = KILL_AFTER_MS,
  maxStdoutBytes = MAX_STDOUT_BYTES,
  command = (binary, args) => ({ command: binary, args, env: {} }),
}: {
  killAfterMs?: number;
  maxStdoutBytes?: number;
  command?: (binary: string, args: readonly string[]) => Command;
} = {}): (binary: string) => Promise<PrintRun> {
  return (binary) =>
    new Promise<PrintRun>((resolve) => {
      let child: ReturnType<typeof spawnUsage>;
      try {
        child = spawnUsage(command(binary, USAGE_ARGS));
      } catch (error) {
        resolve({ kind: "spawn-failed", message: errorMessage(error) });
        return;
      }
      const stdout: Buffer[] = [];
      let stdoutBytes = 0;
      let stderr = "";
      let settled = false;
      const finish = (run: PrintRun) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (run.kind !== "exited") child.kill("SIGKILL");
        resolve(run);
      };
      const timer = setTimeout(() => finish({ kind: "timeout" }), killAfterMs);
      timer.unref();
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > maxStdoutBytes) finish({ kind: "output-too-large" });
        else stdout.push(chunk);
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS);
        if (AUTH_REQUIRED.test(stderr)) finish({ kind: "aborted-auth" });
      });
      child.on("error", (error) => finish({ kind: "spawn-failed", message: error.message }));
      child.on("close", (code) =>
        finish({ kind: "exited", code, stdout: Buffer.concat(stdout).toString("utf8"), stderr }),
      );
    });
}

function spawnUsage({ command, args, env }: Command) {
  return experimental_spawnHostProcess(command, [...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...sanitizeInheritedChildProcessEnv({ env: process.env }), ...env },
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function lastLine(text: string): string {
  return text.trim().split("\n").at(-1)?.trim() ?? "";
}

function parseMessage(failure: ParseFailure): string {
  switch (failure.kind) {
    case "not-expanded":
      return "agy did not return structured /usage JSON. Update agy so print mode expands /usage, then retry.";
    case "provider-error":
      return `agy /usage failed: ${failure.message}`;
    case "malformed":
      return `agy /usage returned unreadable quota data (${failure.detail}).`;
  }
}

function runFailure(run: Exclude<PrintRun, { kind: "exited" }>): ProbeFailure {
  switch (run.kind) {
    case "aborted-auth":
      return { status: "expired" };
    case "timeout":
      return { status: "error", message: `agy did not answer /usage within ${KILL_AFTER_MS / 1000} s.` };
    case "output-too-large":
      return { status: "error", message: "agy /usage output exceeded 4 MiB." };
    case "spawn-failed":
      return { status: "error", message: `Could not start agy: ${run.message}` };
  }
}

export async function probeQuota(ports: ProbePorts): Promise<ProbeOutcome> {
  const binary = ports.locateBinary();
  if (binary === null) return { ok: false, failure: { status: "not_installed" } };
  if (!ports.hasAuthToken()) return { ok: false, failure: { status: "unauthenticated" } };
  const run = await ports.runPrint(binary);
  if (run.kind !== "exited") return { ok: false, failure: runFailure(run) };
  const parsed = parseUsageJson(run.stdout);
  if (run.code !== 0) {
    const detail = parsed.ok ? "" : parsed.failure.kind === "provider-error" ? parsed.failure.message : lastLine(run.stderr);
    return {
      ok: false,
      failure: { status: "error", message: `agy /usage exited with code ${run.code}${detail ? `: ${detail}` : "."}` },
    };
  }
  if (!parsed.ok) return { ok: false, failure: { status: "error", message: parseMessage(parsed.failure) } };
  return {
    ok: true,
    quota: parsed.quota,
    reading: { accountEmail: null, planLabel: null, windows: toQuotaWindows(parsed.quota) },
  };
}

export function withSingleFlight<T>(fn: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return () => {
    inFlight ??= fn().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}
