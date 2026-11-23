import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { parseAccountName, type AccountName } from "./account.ts";

// agy reports an exhausted account only inside the turn: one agent message
// "\n⚠ Individual quota reached. ... Resets in 3h28m24s.\n" and a normal end_turn.
// Requiring the leading warning glyph avoids false positives when an agent
// discusses quota errors in ordinary prose.
export const QUOTA_MESSAGE = /^\s*⚠\uFE0F?\s*.*(?:quota reached|RESOURCE_EXHAUSTED)/i;

/** Matches quota exhaustion inside a structured JSON-RPC error payload. */
export function isQuotaError(text: string): boolean {
  return /quota reached|RESOURCE_EXHAUSTED/i.test(text);
}

const UNKNOWN_RESET_MS = 15 * 60 * 1000;

export function quotaResetMs(text: string): number {
  const match = /Resets in\s+((?:\d+h)?(?:\d+m)?(?:\d+(?:\.\d+)?s)?)/i.exec(text);
  if (!match?.[1]) return UNKNOWN_RESET_MS;
  const part = (unit: string) => Number(new RegExp(`(\\d+(?:\\.\\d+)?)${unit}`).exec(match[1]!)?.[1] ?? 0);
  const ms = (part("h") * 3600 + part("m") * 60 + part("s")) * 1000;
  return ms > 0 ? ms : UNKNOWN_RESET_MS;
}

const fileSchema = z.object({ version: z.literal(1), accounts: z.record(z.string(), z.string()) });

export function exhaustionFile(bindingsFile: string): string {
  return path.join(path.dirname(bindingsFile), "exhausted.json");
}

function readAll(file: string): Record<string, string> {
  try {
    const parsed = fileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    return parsed.success ? parsed.data.accounts : {};
  } catch {
    return {};
  }
}

/** Accounts agy refused for quota, each with the time it is usable again; past marks are dropped. */
export function readExhausted(file: string, now: Date): ReadonlyMap<AccountName, string> {
  const marks = new Map<AccountName, string>();
  for (const [raw, until] of Object.entries(readAll(file))) {
    const name = parseAccountName(raw);
    if (name !== null && Date.parse(until) > now.getTime()) marks.set(name, until);
  }
  return marks;
}

export function markExhausted(file: string, account: AccountName, until: Date): void {
  const accounts = { ...readAll(file), [account]: until.toISOString() };
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ version: 1, accounts }, null, 2)}\n`);
  renameSync(temp, file);
}
