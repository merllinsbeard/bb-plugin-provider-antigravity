import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseTurn, scanConversations } from "../src/pool/stats.ts";

const launcher = fileURLToPath(new URL("../bin/agy-pool", import.meta.url));

// --- A minimal protobuf writer in the layout live agy 1.5.15 stores --------

/** A number, a string, bytes, a nested message (field number to value) or a repeated field (array). */
type Message = Readonly<Record<number, unknown>>;

function varint(n: number): number[] {
  const out: number[] = [];
  while (n >= 0x80) {
    out.push((n % 0x80) | 0x80);
    n = Math.floor(n / 0x80);
  }
  out.push(n);
  return out;
}

function encode(message: Message): Uint8Array {
  const out: number[] = [];
  const put = (field: number, value: unknown): void => {
    if (Array.isArray(value)) return value.forEach((item) => put(field, item));
    if (typeof value === "number") {
      out.push(...varint(field * 8), ...varint(value));
      return;
    }
    const bytes =
      typeof value === "string" ? new TextEncoder().encode(value) : value instanceof Uint8Array ? value : encode(value as Message);
    out.push(...varint(field * 8 + 2), ...varint(bytes.length), ...bytes);
  };
  for (const [field, value] of Object.entries(message)) put(Number(field), value);
  return Uint8Array.from(out);
}

const NEON_HIGH = { enum: 1532, name: "MODEL_PLACEHOLDER_M532", id: "gemini-4-neon", label: "Gemini 4 Neon (High)" };
const OPUS_HIGH = { enum: 1301, name: "MODEL_PLACEHOLDER_M301", id: "claude-opus-5-5-high", label: "Claude Opus 5.5 (High)" };

type Call = {
  model: typeof NEON_HIGH;
  answeredBy?: number;
  input: number;
  cacheRead?: number;
  thinking: number;
  response: number;
  context: number;
  ttftMs: number;
  streamingMs: number;
  step: number;
};

const duration = (ms: number) => ({ 1: Math.floor(ms / 1000), 2: (ms % 1000) * 1e6 });

function genMetadata(call: Call): Uint8Array {
  const usage = {
    1: call.answeredBy ?? call.model.enum,
    2: call.input,
    3: call.thinking + call.response,
    ...(call.cacheRead ? { 5: call.cacheRead } : {}),
    6: 24,
    7: "resp-id",
    9: call.thinking,
    10: call.response,
  };
  const label = (key: string, value: string) => ({ 1: key, 2: value });
  return encode({
    1: {
      2: [{ 1: "SECRET-PROMPT-TEXT in a chat message" }],
      3: call.model.enum,
      4: usage,
      9: { 10: { 1: call.context, 4: 512000 } },
      11: duration(call.ttftMs),
      12: duration(call.streamingMs),
      19: call.model.id,
      20: [label("model_enum", call.model.name), label("last_step_index", String(call.step)), label("used_claude", "false")],
      21: call.model.label,
    },
    4: "9b5203fb-2048-4644-a651-bda42c3fa948",
  });
}

const SCHEMA = [
  "CREATE TABLE `steps` (`idx` integer,`step_type` integer NOT NULL DEFAULT 0,`status` integer NOT NULL DEFAULT 0,`metadata` blob,`step_payload` blob,PRIMARY KEY (`idx`))",
  "CREATE TABLE `gen_metadata` (`idx` integer,`data` blob,`size` integer NOT NULL DEFAULT 0,PRIMARY KEY (`idx`))",
];

/** Writes one conversation; each call's step is stamped `at`. Returns the writer when asked to keep it open. */
function conversation(file: string, calls: ReadonlyArray<Call & { at: Date }>, options: { wal?: boolean; keepOpen?: boolean } = {}) {
  const db = new DatabaseSync(file);
  if (options.wal) db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
  for (const sql of SCHEMA) db.exec(sql);
  calls.forEach((call, idx) => {
    db.prepare("INSERT INTO steps (idx, metadata, step_payload) VALUES (?, ?, ?)").run(
      call.step,
      encode({ 1: { 1: Math.floor(call.at.getTime() / 1000), 2: 0 }, 3: 4 }),
      new TextEncoder().encode("SECRET-FILE-CONTENTS sk-live-123"),
    );
    db.prepare("INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, 0)").run(idx, genMetadata(call));
  });
  if (options.keepOpen) return db;
  db.close();
  return null;
}

const HOUR = 3600_000;
const now = new Date("2026-11-26T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);

describe("agy-pool stats", () => {
  let root: string;
  let dir: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "agy-stats-"));
    dir = path.join(root, "conversations");
    mkdirSync(dir);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const neon = (over: Partial<Call>): Call => ({
    model: NEON_HIGH,
    input: 0,
    thinking: 0,
    response: 0,
    context: 0,
    ttftMs: 0,
    streamingMs: 0,
    step: 0,
    ...over,
  });

  it("totals tokens and the cache hit rate, and breaks them down by model, heaviest first", () => {
    conversation(path.join(dir, "a.db"), [
      { ...neon({ input: 1000, thinking: 300, response: 200, context: 100_000, ttftMs: 4000, streamingMs: 1000, step: 1 }), at: ago(HOUR) },
      {
        ...neon({ input: 500, cacheRead: 9000, thinking: 100, response: 400, context: 110_000, ttftMs: 2000, streamingMs: 3000, step: 5 }),
        at: ago(HOUR),
      },
    ]);
    conversation(path.join(dir, "b.db"), [
      { ...neon({ model: OPUS_HIGH, input: 200, cacheRead: 800, thinking: 0, response: 100, context: 50_000, ttftMs: 1000, streamingMs: 1000 }), at: ago(HOUR) },
    ]);

    const report = scanConversations(dir, "24h", now);

    expect(report).toMatchObject({
      since: "24h",
      from: ago(24 * HOUR).toISOString(),
      conversationsScanned: 2,
      conversationsSkipped: 0,
      turns: 3,
      inputTokens: 1700,
      cacheReadTokens: 9800,
      outputTokens: 700,
      thinkingTokens: 400,
      totalTokens: 1700 + 9800 + 700 + 400,
      cacheHitRate: Math.round((9800 / 11500) * 1e4) / 1e4,
      avgContextTokens: Math.round(260_000 / 3),
      avgTtftMs: Math.round(7000 / 3),
      // (500 + 500 + 100) generated tokens over (5 + 5 + 2) s of calls.
      avgTokensPerSec: Math.round((1100 / 12) * 10) / 10,
      downgradedTurns: 0,
    });
    expect(report.byModel.map((m) => [m.model, m.turns, m.totalTokens, m.cacheHitRate])).toEqual([
      ["Gemini 4 Neon (High)", 2, 11_500, 0.8571],
      ["Claude Opus 5.5 (High)", 1, 1_100, 0.8],
    ]);
  });

  it("counts a call answered by another model than the one requested as downgraded", () => {
    conversation(path.join(dir, "a.db"), [
      { ...neon({ input: 10, response: 1, step: 0 }), at: ago(HOUR) },
      { ...neon({ input: 10, response: 1, step: 1, answeredBy: 1533 }), at: ago(HOUR) },
    ]);
    const report = scanConversations(dir, "24h", now);
    expect(report.downgradedTurns).toBe(1);
    expect(report.byModel[0]!.downgradedTurns).toBe(1);
  });

  it("counts calls by their own step time and does not open conversations last written before the window", () => {
    conversation(path.join(dir, "mixed.db"), [
      { ...neon({ input: 1, step: 0 }), at: ago(3 * 24 * HOUR) },
      { ...neon({ input: 2, step: 1 }), at: ago(HOUR) },
    ]);
    const old = path.join(dir, "old.db");
    conversation(old, [{ ...neon({ input: 4, step: 0 }), at: ago(40 * 24 * HOUR) }]);
    utimesSync(old, ago(40 * 24 * HOUR), ago(40 * 24 * HOUR));

    const pick = (since: "24h" | "7d" | "30d" | "all") => {
      const report = scanConversations(dir, since, now);
      return [report.conversationsScanned, report.turns, report.inputTokens];
    };
    expect(pick("24h")).toEqual([1, 1, 2]);
    expect(pick("7d")).toEqual([1, 2, 3]);
    expect(pick("30d")).toEqual([1, 2, 3]);
    expect(pick("all")).toEqual([2, 3, 7]);
  });

  it("skips unreadable conversations and unreadable rows without failing", () => {
    writeFileSync(path.join(dir, "empty.db"), "");
    writeFileSync(path.join(dir, "garbage.db"), "this is not a sqlite database at all, just text".repeat(100));
    new DatabaseSync(path.join(dir, "no-tables.db")).close();
    const db = conversation(path.join(dir, "rows.db"), [{ ...neon({ input: 7, step: 0 }), at: ago(HOUR) }], { keepOpen: true })!;
    // Truncated length, an over-long varint, a group wire type and a row far past the size cap.
    const bad = [Uint8Array.of(0x0a, 0x50, 0x01), Uint8Array.of(0x08, ...Array(11).fill(0xff)), Uint8Array.of(0x0b), new Uint8Array(2 * 1024 * 1024)];
    bad.forEach((data, i) => db.prepare("INSERT INTO gen_metadata (idx, data) VALUES (?, ?)").run(100 + i, data));
    db.close();

    const report = scanConversations(dir, "24h", now);
    expect(report.conversationsSkipped).toBe(3);
    expect(report.conversationsScanned).toBe(1);
    expect(report.turns).toBe(1);
    expect(report.inputTokens).toBe(7);
    for (const data of bad.slice(0, 3)) expect(parseTurn(data)).toBeNull();
  });

  it("refuses conversations whose tables SQLite would have to compute, instead of hanging", () => {
    const view = new DatabaseSync(path.join(dir, "view.db"));
    view.exec(SCHEMA[0]!);
    view.exec("CREATE VIEW gen_metadata AS WITH RECURSIVE n(idx, data) AS (SELECT 0, x'00' UNION ALL SELECT idx + 1, data FROM n) SELECT idx, data FROM n");
    view.close();
    const generated = new DatabaseSync(path.join(dir, "generated.db"));
    generated.exec(SCHEMA[0]!);
    generated.exec("CREATE TABLE gen_metadata (idx integer PRIMARY KEY, n integer, data blob GENERATED ALWAYS AS (zeroblob(n)) VIRTUAL)");
    generated.exec("INSERT INTO gen_metadata (idx, n) VALUES (0, 900000)");
    generated.close();

    const report = scanConversations(dir, "24h", now);
    expect(report.conversationsSkipped).toBe(2);
    expect(report.turns).toBe(0);
  });

  it("reports an empty store and a missing folder as zero usage", () => {
    expect(scanConversations(path.join(root, "absent"), "7d", now)).toMatchObject({ conversationsScanned: 0, turns: 0, cacheHitRate: null, byModel: [] });
  });

  it("never writes to an idle WAL conversation: no -wal or -shm appear and the file is untouched", () => {
    const file = path.join(dir, "idle.db");
    conversation(file, [{ ...neon({ input: 3, step: 0 }), at: ago(HOUR) }], { wal: true });
    // Header bytes 18-19 are 2 for a WAL database.
    expect([...readFileSync(file).subarray(18, 20)]).toEqual([2, 2]);
    for (const side of ["-wal", "-shm"]) rmSync(`${file}${side}`, { force: true });
    const before = statSync(file);
    const bytes = readFileSync(file);

    expect(scanConversations(dir, "24h", now).inputTokens).toBe(3);

    expect(readdirSync(dir)).toEqual(["idle.db"]);
    expect(statSync(file).mtimeMs).toBe(before.mtimeMs);
    expect(readFileSync(file).equals(bytes)).toBe(true);
  });

  it("reads calls still in the WAL of a conversation agy holds open, without writing to it", () => {
    const file = path.join(dir, "live.db");
    const writer = conversation(file, [{ ...neon({ input: 5, step: 0 }), at: ago(HOUR) }], { wal: true, keepOpen: true })!;
    try {
      const mainBytes = readFileSync(file);
      const files = readdirSync(dir).sort();
      expect(files).toEqual(["live.db", "live.db-shm", "live.db-wal"]);

      expect(scanConversations(dir, "24h", now).inputTokens).toBe(5);

      expect(readdirSync(dir).sort()).toEqual(files);
      expect(readFileSync(file).equals(mainBytes)).toBe(true);
    } finally {
      writer.close();
    }
  });

  describe("command line", () => {
    const run = (args: string[]) => {
      const home = path.join(root, "home");
      const store = path.join(home, ".gemini", "antigravity-cli", "conversations");
      mkdirSync(store, { recursive: true });
      if (!existsSync(path.join(store, "c.db")))
        conversation(path.join(store, "c.db"), [
          { ...neon({ input: 100, cacheRead: 900, thinking: 20, response: 30, context: 1000, ttftMs: 500, streamingMs: 500 }), at: new Date() },
        ]);
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("AGY_")));
      return spawnSync(launcher, ["stats", ...args], { env: { ...env, HOME: home }, encoding: "utf8" });
    };

    it("prints JSON with numbers and model names only", () => {
      const result = run(["--since", "7d", "--json"]);
      expect(result.status).toBe(0);
      const report = JSON.parse(result.stdout);
      expect(report).toMatchObject({ since: "7d", turns: 1, cacheHitRate: 0.9, totalTokens: 1050 });
      expect(report.byModel[0].model).toBe("Gemini 4 Neon (High)");
      expect(result.stdout).not.toMatch(/SECRET|sk-live|9b5203fb/);
    });

    it("prints a table by default and the last 24 hours when no window is given", () => {
      const result = run([]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("last 24h");
      expect(result.stdout).toContain("Cache hit rate 90.0%");
      expect(result.stdout).toMatch(/Gemini 4 Neon \(High\)\s+1\s+1\.1k\s+90\.0%/);
      expect(result.stdout).not.toMatch(/SECRET|sk-live/);
    });

    it("rejects an unknown window or flag", () => {
      for (const args of [["--since", "1y"], ["--since"], ["--verbose"]]) {
        const result = run(args);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("usage `agy-pool stats");
      }
    });
  });
});
