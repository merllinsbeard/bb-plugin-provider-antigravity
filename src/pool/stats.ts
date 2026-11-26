import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

/**
 * Token and prompt-cache telemetry read from agy's own conversation store
 * (`conversations/<id>.db`), with no proxy in the request path. Only numbers
 * and model names leave this module; message text, prompts and tool payloads
 * live in other columns and fields that are never decoded.
 *
 * Field numbers below were read off live agy 1.5.15 databases: each
 * `gen_metadata.data` row is one model call, and `steps.metadata` carries the
 * creation time of the step that call ended on.
 */
const GEN_METADATA = { chat: 1 } as const;
const CHAT = {
  requestedModelEnum: 3,
  usage: 4,
  context: 9,
  ttft: 11,
  streaming: 12,
  physicalModel: 19,
  label: 20,
  displayModel: 21,
} as const;
/** Cascade `ModelUsageStats`: `output` (3) is `thinking` (9) plus `response` (10). */
const USAGE = { modelEnum: 1, input: 2, output: 3, cacheRead: 5, thinking: 9, response: 10 } as const;
const CONTEXT = { window: 10 } as const;
const CONTEXT_WINDOW = { used: 1 } as const;
const LABEL = { key: 1, value: 2 } as const;
/** `google.protobuf.Duration` and `Timestamp` share this shape. */
const SECONDS_NANOS = { seconds: 1, nanos: 2 } as const;
const STEP_METADATA = { createdAt: 1 } as const;

/** A row bigger than this is not a usage record; it is skipped without being read. */
const MAX_BLOB_BYTES = 1024 * 1024;
const MAX_NAME_CHARS = 80;
const BUSY_TIMEOUT_MS = 200;
/** Far above any real conversation (the largest live one holds a few hundred calls). */
const MAX_ROWS = 100_000;
const MAX_READ_BYTES = 256 * 1024 * 1024;

type FieldValue = number | Uint8Array;
type Fields = ReadonlyArray<readonly [field: number, value: FieldValue]>;

/**
 * Decodes one message level. Varints become numbers (exact up to 2^53, which
 * covers every counter here); length-delimited fields stay raw bytes for the
 * caller to decode on demand; fixed-width fields are skipped. Anything that
 * runs past the buffer, uses group wire types or an over-long varint makes
 * the whole message unreadable: null.
 */
export function decodeMessage(bytes: Uint8Array): Fields | null {
  const fields: Array<readonly [number, FieldValue]> = [];
  let at = 0;
  const varint = (): number | null => {
    let value = 0;
    let scale = 1;
    for (let i = 0; i < 10; i++) {
      if (at >= bytes.length) return null;
      const byte = bytes[at++]!;
      value += (byte & 0x7f) * scale;
      if ((byte & 0x80) === 0) return value;
      scale *= 128;
    }
    return null;
  };
  while (at < bytes.length) {
    const tag = varint();
    if (tag === null) return null;
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    if (field === 0) return null;
    if (wire === 0) {
      const value = varint();
      if (value === null) return null;
      fields.push([field, value]);
    } else if (wire === 2) {
      const length = varint();
      if (length === null || length > bytes.length - at) return null;
      fields.push([field, bytes.subarray(at, at + length)]);
      at += length;
    } else if (wire === 1 || wire === 5) {
      at += wire === 1 ? 8 : 4;
      if (at > bytes.length) return null;
    } else {
      return null;
    }
  }
  return fields;
}

const intField = (fields: Fields, n: number): number | null => {
  const hit = fields.find(([field, value]) => field === n && typeof value === "number");
  return hit === undefined ? null : (hit[1] as number);
};

const bytesFields = (fields: Fields, n: number): Uint8Array[] =>
  fields.flatMap(([field, value]) => (field === n && typeof value !== "number" ? [value] : []));

const messageField = (fields: Fields, n: number): Fields | null => {
  const [first] = bytesFields(fields, n);
  return first === undefined ? null : decodeMessage(first);
};

/** Printable ASCII only, so a crafted database cannot put terminal escapes on screen. */
function nameField(fields: Fields, n: number): string | null {
  const [first] = bytesFields(fields, n);
  if (first === undefined) return null;
  const text = new TextDecoder("utf-8", { fatal: false })
    .decode(first)
    .replace(/[^\x20-\x7e]/g, "")
    .trim()
    .slice(0, MAX_NAME_CHARS);
  return text === "" ? null : text;
}

function millis(fields: Fields | null): number | null {
  if (fields === null) return null;
  const seconds = intField(fields, SECONDS_NANOS.seconds) ?? 0;
  const nanos = intField(fields, SECONDS_NANOS.nanos) ?? 0;
  return seconds === 0 && nanos === 0 ? null : seconds * 1000 + nanos / 1e6;
}

/** One model call, as numbers and model names only. */
export type Turn = {
  /** When the call's step was created; null when the conversation does not say. */
  readonly at: Date | null;
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  /** Visible response tokens, thinking excluded. */
  readonly outputTokens: number;
  readonly thinkingTokens: number;
  readonly contextUsedTokens: number | null;
  readonly ttftMs: number | null;
  readonly streamingMs: number | null;
  /** Backend model id that answered, e.g. `gemini-4-neon`. */
  readonly physicalModel: string | null;
  /** The label the picker showed, e.g. `Gemini 4 Neon (High)`. */
  readonly displayModel: string | null;
  /** agy's enum name for the model the user asked for, e.g. `MODEL_PLACEHOLDER_M532`. */
  readonly requestedModel: string | null;
  /** The call was answered by a different model enum than the one requested. */
  readonly isDowngraded: boolean;
};

export type ParsedTurn = Omit<Turn, "at"> & { readonly stepIndex: number | null };

function labels(chat: Fields): ReadonlyMap<string, string> {
  const entries = new Map<string, string>();
  for (const raw of bytesFields(chat, CHAT.label)) {
    const label = decodeMessage(raw);
    if (label === null) continue;
    const key = nameField(label, LABEL.key);
    const value = nameField(label, LABEL.value);
    if (key !== null && value !== null) entries.set(key, value);
  }
  return entries;
}

/** Parses one `gen_metadata.data` blob; null when it is not a readable model call. */
export function parseTurn(data: Uint8Array): ParsedTurn | null {
  const top = decodeMessage(data);
  const chat = top && messageField(top, GEN_METADATA.chat);
  if (!chat) return null;
  const usage = messageField(chat, CHAT.usage) ?? [];
  const output = intField(usage, USAGE.output) ?? 0;
  const thinking = intField(usage, USAGE.thinking) ?? 0;
  const window = messageField(messageField(chat, CHAT.context) ?? [], CONTEXT.window);
  const requestedEnum = intField(chat, CHAT.requestedModelEnum);
  const answeredEnum = intField(usage, USAGE.modelEnum);
  const tags = labels(chat);
  const step = Number(tags.get("last_step_index"));
  return {
    stepIndex: Number.isSafeInteger(step) && step >= 0 ? step : null,
    inputTokens: intField(usage, USAGE.input) ?? 0,
    cacheReadTokens: intField(usage, USAGE.cacheRead) ?? 0,
    outputTokens: intField(usage, USAGE.response) ?? Math.max(0, output - thinking),
    thinkingTokens: thinking,
    contextUsedTokens: window ? intField(window, CONTEXT_WINDOW.used) : null,
    ttftMs: millis(messageField(chat, CHAT.ttft)),
    streamingMs: millis(messageField(chat, CHAT.streaming)),
    physicalModel: nameField(chat, CHAT.physicalModel),
    displayModel: nameField(chat, CHAT.displayModel),
    requestedModel: tags.get("model_enum") ?? null,
    isDowngraded: requestedEnum !== null && answeredEnum !== null && requestedEnum !== answeredEnum,
  };
}

/** Creation time from one `steps.metadata` blob. */
export function parseStepTime(metadata: Uint8Array): Date | null {
  const fields = decodeMessage(metadata);
  const ms = fields && millis(messageField(fields, STEP_METADATA.createdAt));
  return ms ? new Date(ms) : null;
}

export const SINCE_WINDOWS = { "24h": 24 * 3600_000, "7d": 7 * 24 * 3600_000, "30d": 30 * 24 * 3600_000, all: null } as const;
export type Since = keyof typeof SINCE_WINDOWS;

export function parseSince(raw: string): Since | null {
  return Object.hasOwn(SINCE_WINDOWS, raw) ? (raw as Since) : null;
}

function cutoffOf(since: Since, now: Date): Date | null {
  const span = SINCE_WINDOWS[since];
  return span === null ? null : new Date(now.getTime() - span);
}

type Tally = {
  turns: number;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  downgradedTurns: number;
  contextSum: number;
  contextTurns: number;
  ttftSum: number;
  ttftTurns: number;
  generatedTokens: number;
  callMs: number;
};

const emptyTally = (): Tally => ({
  turns: 0,
  inputTokens: 0,
  cacheReadTokens: 0,
  outputTokens: 0,
  thinkingTokens: 0,
  downgradedTurns: 0,
  contextSum: 0,
  contextTurns: 0,
  ttftSum: 0,
  ttftTurns: 0,
  generatedTokens: 0,
  callMs: 0,
});

function add(tally: Tally, turn: Turn): void {
  tally.turns++;
  tally.inputTokens += turn.inputTokens;
  tally.cacheReadTokens += turn.cacheReadTokens;
  tally.outputTokens += turn.outputTokens;
  tally.thinkingTokens += turn.thinkingTokens;
  if (turn.isDowngraded) tally.downgradedTurns++;
  if (turn.contextUsedTokens !== null) {
    tally.contextSum += turn.contextUsedTokens;
    tally.contextTurns++;
  }
  if (turn.ttftMs !== null) {
    tally.ttftSum += turn.ttftMs;
    tally.ttftTurns++;
  }
  if (turn.ttftMs !== null && turn.streamingMs !== null) {
    tally.generatedTokens += turn.outputTokens + turn.thinkingTokens;
    tally.callMs += turn.ttftMs + turn.streamingMs;
  }
}

export type UsageSummary = {
  readonly turns: number;
  /** input + cacheRead + output + thinking */
  readonly totalTokens: number;
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  readonly outputTokens: number;
  readonly thinkingTokens: number;
  /** cacheRead / (cacheRead + input), null with no prompt tokens. */
  readonly cacheHitRate: number | null;
  readonly avgContextTokens: number | null;
  readonly avgTtftMs: number | null;
  /**
   * Generated (output + thinking) tokens per second of call time (TTFT +
   * streaming). Some models think before their first token and others stream
   * their thinking, so dividing by streaming time alone would overstate the
   * former many times over.
   */
  readonly avgTokensPerSec: number | null;
  readonly downgradedTurns: number;
};

export type ModelSummary = UsageSummary & { readonly model: string };

export type StatsReport = UsageSummary & {
  readonly since: Since;
  /** Start of the window, ISO; null for `all`. */
  readonly from: string | null;
  readonly conversationsScanned: number;
  readonly conversationsSkipped: number;
  readonly byModel: readonly ModelSummary[];
};

const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits;
const ratio = (num: number, den: number, digits: number) => (den > 0 ? round(num / den, digits) : null);

function summarize(tally: Tally): UsageSummary {
  const prompt = tally.inputTokens + tally.cacheReadTokens;
  return {
    turns: tally.turns,
    totalTokens: prompt + tally.outputTokens + tally.thinkingTokens,
    inputTokens: tally.inputTokens,
    cacheReadTokens: tally.cacheReadTokens,
    outputTokens: tally.outputTokens,
    thinkingTokens: tally.thinkingTokens,
    cacheHitRate: ratio(tally.cacheReadTokens, prompt, 4),
    avgContextTokens: ratio(tally.contextSum, tally.contextTurns, 0),
    avgTtftMs: ratio(tally.ttftSum, tally.ttftTurns, 0),
    avgTokensPerSec: ratio(tally.generatedTokens * 1000, tally.callMs, 1),
    downgradedTurns: tally.downgradedTurns,
  };
}

export const modelKey = (turn: Turn): string => turn.displayModel ?? turn.physicalModel ?? "unknown";

/** Pure: totals and a per-model breakdown, heaviest model first. */
export function aggregate(
  turns: Iterable<Turn>,
  scope: { readonly since: Since; readonly from: Date | null; readonly scanned: number; readonly skipped: number },
): StatsReport {
  const total = emptyTally();
  const models = new Map<string, Tally>();
  for (const turn of turns) {
    add(total, turn);
    const key = modelKey(turn);
    const tally = models.get(key) ?? emptyTally();
    models.set(key, tally);
    add(tally, turn);
  }
  const byModel = [...models]
    .map(([model, tally]) => ({ model, ...summarize(tally) }))
    .sort((a, b) => b.totalTokens - a.totalTokens || a.model.localeCompare(b.model));
  return {
    since: scope.since,
    from: scope.from?.toISOString() ?? null,
    conversationsScanned: scope.scanned,
    conversationsSkipped: scope.skipped,
    ...summarize(total),
    byModel,
  };
}

/**
 * Opens a conversation without writing to it. `mode=ro` is only safe
 * when agy already holds the database open: on an idle WAL database SQLite
 * would create `-wal` and `-shm` beside it even read-only, so those are read
 * `immutable=1` (no locks, no sidecars). A live database needs `mode=ro` to
 * see turns still sitting in its WAL (as any SQLite reader, it updates
 * read marks in the existing `-shm`; the database and `-wal` stay untouched);
 * if that fails it is read immutable.
 */
function openReadOnly(file: string): DatabaseSync {
  const uri = pathToFileURL(file).href;
  const open = (query: string) => new DatabaseSync(`${uri}?${query}`, { readOnly: true, timeout: BUSY_TIMEOUT_MS });
  if (existsSync(`${file}-wal`) && existsSync(`${file}-shm`)) {
    try {
      return open("mode=ro");
    } catch {}
  }
  return open("immutable=1");
}

/**
 * True when `gen_metadata` and `steps` are ordinary tables with stored
 * columns. A view or a generated column would make SQLite compute rows,
 * which a crafted file can turn into an endless query.
 */
function hasPlainTables(db: DatabaseSync): boolean {
  const schema = db.prepare("SELECT type, sql FROM sqlite_master WHERE name = ?");
  for (const table of ["gen_metadata", "steps"]) {
    const entry = schema.get(table);
    if (entry?.type !== "table" || typeof entry.sql !== "string" || !/^CREATE TABLE/i.test(entry.sql)) return false;
    if (db.prepare(`PRAGMA table_xinfo(${table})`).all().some((column) => column.hidden !== 0)) return false;
  }
  return true;
}

/** Every readable model call in one conversation, or null when the file is not a readable conversation. */
export function readConversation(file: string, fallbackAt: Date): Turn[] | null {
  let db: DatabaseSync | null = null;
  try {
    db = openReadOnly(file);
    db.exec("PRAGMA trusted_schema = OFF");
    if (!hasPlainTables(db)) return null;
    const stepMetadata = db.prepare("SELECT metadata FROM steps WHERE idx = ? AND length(metadata) <= ?");
    const rows = db.prepare("SELECT data FROM gen_metadata WHERE length(data) <= ?").iterate(MAX_BLOB_BYTES);
    const turns: Turn[] = [];
    let seen = 0;
    let bytes = 0;
    for (const row of rows) {
      if (++seen > MAX_ROWS || bytes > MAX_READ_BYTES) break;
      if (!(row.data instanceof Uint8Array)) continue;
      bytes += row.data.length;
      const parsed = parseTurn(row.data);
      if (parsed === null) continue;
      const { stepIndex, ...turn } = parsed;
      const step = stepIndex === null ? undefined : stepMetadata.get(stepIndex, MAX_BLOB_BYTES);
      const at = step?.metadata instanceof Uint8Array ? parseStepTime(step.metadata) : null;
      turns.push({ ...turn, at: at ?? fallbackAt });
    }
    return turns;
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

function lastWrite(file: string): Date | null {
  try {
    const db = statSync(file);
    if (!db.isFile()) return null;
    let ms = db.mtimeMs;
    try {
      ms = Math.max(ms, statSync(`${file}-wal`).mtimeMs);
    } catch {}
    return new Date(ms);
  } catch {
    return null;
  }
}

/**
 * Scans `<dir>/*.db`. A conversation last written before the window is not
 * opened; inside it, each call counts by its own step time (the file's last
 * write when the call has none).
 */
export function scanConversations(dir: string, since: Since, now: Date = new Date()): StatsReport {
  const from = cutoffOf(since, now);
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".db"));
  } catch {}
  let scanned = 0;
  let skipped = 0;
  const turns: Turn[] = [];
  for (const name of names.sort()) {
    const file = path.join(dir, name);
    const written = lastWrite(file);
    if (written === null) continue;
    if (from !== null && written < from) continue;
    const read = readConversation(file, written);
    if (read === null) {
      skipped++;
      continue;
    }
    scanned++;
    for (const turn of read) if (from === null || turn.at === null || turn.at >= from) turns.push(turn);
  }
  return aggregate(turns, { since, from, scanned, skipped });
}

const compact = (n: number) =>
  n >= 1e9 ? `${round(n / 1e9, 2)}B` : n >= 1e6 ? `${round(n / 1e6, 2)}M` : n >= 1e3 ? `${round(n / 1e3, 1)}k` : String(n);
const percent = (rate: number | null) => (rate === null ? "-" : `${(rate * 100).toFixed(1)}%`);
const seconds = (ms: number | null) => (ms === null ? "-" : `${(ms / 1000).toFixed(1)}s`);
const orDash = (value: number | null, format: (n: number) => string) => (value === null ? "-" : format(value));

export function formatReport(report: StatsReport): string {
  const window = report.since === "all" ? "all time" : `last ${report.since}`;
  const lines = [
    `agy-pool stats: ${window}, ${report.conversationsScanned} conversations` +
      (report.conversationsSkipped > 0 ? ` (${report.conversationsSkipped} unreadable, skipped)` : "") +
      `, ${report.turns} model calls`,
    `Cache hit rate ${percent(report.cacheHitRate)}  |  tokens ${compact(report.totalTokens)}: input ${compact(report.inputTokens)}, ` +
      `cache read ${compact(report.cacheReadTokens)}, output ${compact(report.outputTokens)}, thinking ${compact(report.thinkingTokens)}`,
    `Avg context ${orDash(report.avgContextTokens, compact)}  |  TTFT ${seconds(report.avgTtftMs)}  |  ` +
      `${orDash(report.avgTokensPerSec, (n) => n.toFixed(0))} tok/s  |  downgraded calls ${report.downgradedTurns}`,
  ];
  if (report.byModel.length === 0) return `${lines.join("\n")}\n`;
  const header = ["Model", "Calls", "Tokens", "Cache hit", "Avg ctx", "TTFT", "tok/s", "Downgr."];
  const rows = report.byModel.map((m) => [
    m.model,
    String(m.turns),
    compact(m.totalTokens),
    percent(m.cacheHitRate),
    orDash(m.avgContextTokens, compact),
    seconds(m.avgTtftMs),
    orDash(m.avgTokensPerSec, (n) => n.toFixed(0)),
    String(m.downgradedTurns),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i]!.length)));
  const line = (cells: string[]) => cells.map((cell, i) => (i === 0 ? cell.padEnd(widths[i]!) : cell.padStart(widths[i]!))).join("  ");
  return `${[...lines, "", line(header), ...rows.map(line)].join("\n")}\n`;
}
