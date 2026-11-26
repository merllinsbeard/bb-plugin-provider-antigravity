import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ProviderQuota } from "../usage/types.ts";
import { parseAccountName, type AccountName } from "./account.ts";
import { bucketFamily, parseModelFamily, type ModelFamily } from "./family.ts";
import { accountRoom } from "./pick.ts";

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

// Version 2 keys each mark by model family. Version 1 marked whole accounts,
// which locked Gemini threads out when only Claude/GPT ran out, so its marks
// are ignored.
const fileSchema = z.object({ version: z.literal(2), accounts: z.record(z.string(), z.record(z.string(), z.string())) });

export type Exhausted = ReadonlyMap<AccountName, ReadonlyMap<ModelFamily, string>>;

export function exhaustionFile(bindingsFile: string): string {
  return path.join(path.dirname(bindingsFile), "exhausted.json");
}

function readAll(file: string): Record<string, Record<string, string>> {
  try {
    const parsed = fileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    return parsed.success ? parsed.data.accounts : {};
  } catch {
    return {};
  }
}

/** Account and model family pairs agy refused for quota, each with the time it is usable again; past marks are dropped. */
export function readExhausted(file: string, now: Date): Exhausted {
  const marks = new Map<AccountName, Map<ModelFamily, string>>();
  for (const [rawAccount, families] of Object.entries(readAll(file))) {
    const name = parseAccountName(rawAccount);
    if (name === null) continue;
    for (const [rawFamily, until] of Object.entries(families)) {
      const family = parseModelFamily(rawFamily);
      if (family !== null && Date.parse(until) > now.getTime()) marks.set(name, (marks.get(name) ?? new Map()).set(family, until));
    }
  }
  return marks;
}

export function exhaustedUntil(marks: Exhausted, account: AccountName, family: ModelFamily): string | undefined {
  return marks.get(account)?.get(family);
}

function writeAll(file: string, accounts: Record<string, Record<string, string>>): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ version: 2, accounts }, null, 2)}\n`);
  renameSync(temp, file);
}

export function markExhausted(file: string, account: AccountName, family: ModelFamily, until: Date): void {
  const all = readAll(file);
  writeAll(file, { ...all, [account]: { ...all[account], [family]: until.toISOString() } });
}

export type ExhaustionEntry = { readonly account: AccountName; readonly family: ModelFamily };

/** Drops the marks of exactly these account and family pairs; other marks stay. */
export function clearExhausted(file: string, entries: readonly ExhaustionEntry[]): void {
  const all = readAll(file);
  let changed = false;
  for (const { account, family } of entries) {
    if (all[account]?.[family] === undefined) continue;
    const { [family]: _cleared, ...rest } = all[account];
    if (Object.keys(rest).length > 0) all[account] = rest;
    else delete all[account];
    changed = true;
  }
  if (changed) writeAll(file, all);
}

const SAME_WINDOW_MS = 5 * 60_000;

/**
 * A mark is stale when the live quota says the account has room for `family` and
 * no 5h or weekly window of that family resets at the marked time. agy's "Resets in"
 * lands within a second of the window that refused, so a window still resetting at
 * the mark means the refusal stands, even when that window shows a sliver left
 * (agy refuses Gemini at 99.6% used). Google also resets weekly windows early;
 * then every live reset moved away from the mark and the account is usable again.
 */
export function isMarkStale(markIso: string, quota: ProviderQuota, family: ModelFamily, toleranceMs = SAME_WINDOW_MS): boolean {
  if (accountRoom(quota, family)?.usable !== true) return false;
  const mark = Date.parse(markIso);
  return !quota.groups.some((group) =>
    group.buckets.some((bucket) => {
      if (bucketFamily(bucket.bucketId) !== family || (bucket.window !== "5h" && bucket.window !== "weekly")) return false;
      const reset = bucket.resetsAtIso === null ? NaN : Date.parse(bucket.resetsAtIso);
      return Number.isFinite(reset) && Math.abs(reset - mark) <= toleranceMs;
    }),
  );
}
