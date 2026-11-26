import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { account as readAccount, type AccountName } from "../src/pool/account.ts";
import { accountUsage } from "../src/usage/account-usage.ts";
import { readDirectQuota } from "../src/usage/direct-api.ts";
import { parseUsageJson } from "../src/usage/print-reader.ts";
import { probeQuota, type PrintRun } from "../src/usage/probe.ts";
import type { ProbeOutcome } from "../src/usage/types.ts";
import { toQuotaWindows } from "../src/usage/windows.ts";

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
/** Live captures from one account at the same moment: the API reply and `agy -p /usage` (3p-5h disabled). */
const liveSummary = readFileSync(path.join(fixtures, "quota-summary-live.json"), "utf8");
const liveAgyUsage = readFileSync(path.join(fixtures, "usage-live-disabled.json"), "utf8");
const proAssist = JSON.stringify({ currentTier: { id: "free-tier" }, paidTier: { id: "g1-pro-tier" }, cloudaicompanionProject: "p" });

const TOKEN = "ya29.SECRET-access-token";
const PROXY_PASSWORD = "proxy-SECRET-pw";

type Reply = { status: number; body: string };
type Seen = { path: string; authorization?: string; userAgent?: string; body: string; viaProxy: boolean; curlArgv: string[] };

/** Command lines of running curl processes, as anyone on the host can read them. */
function curlCommandLines(): string[] {
  return readdirSync("/proc")
    .filter((entry) => /^\d+$/.test(entry))
    .flatMap((pid) => {
      try {
        const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
        return path.basename(argv[0] ?? "") === "curl" ? [argv.join(" ")] : [];
      } catch {
        return [];
      }
    });
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

let scratch: string;
let api: http.Server;
let apiPort: number;
let proxy: http.Server;
let proxyPort: number;
let replies: Record<string, Reply>;
let seen: Seen[];
let proxied: { url: string; proxyAuthorization?: string }[];

beforeEach(async () => {
  scratch = mkdtempSync(path.join(tmpdir(), "agy-direct-"));
  replies = {
    "/v1internal:retrieveUserQuotaSummary": { status: 200, body: liveSummary },
    "/v1internal:loadCodeAssist": { status: 200, body: proAssist },
  };
  seen = [];
  proxied = [];
  api = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      seen.push({
        path: req.url ?? "",
        authorization: req.headers.authorization,
        userAgent: req.headers["user-agent"],
        body,
        viaProxy: req.headers["x-via-stub-proxy"] === "1",
        curlArgv: curlCommandLines(),
      });
      const reply = replies[req.url ?? ""] ?? { status: 404, body: "not found" };
      res.writeHead(reply.status, { "content-type": "application/json" }).end(reply.body);
    });
  });
  apiPort = await listen(api);
  // A forward proxy for plain-http targets: relays the request and marks it.
  proxy = http.createServer((req, res) => {
    proxied.push({ url: req.url ?? "", proxyAuthorization: req.headers["proxy-authorization"] });
    const target = new URL(req.url ?? "");
    const headers = { ...req.headers, "x-via-stub-proxy": "1" };
    delete headers["proxy-authorization"];
    const upstream = http.request({ host: target.hostname, port: target.port, path: target.pathname, method: req.method, headers }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    req.pipe(upstream);
  });
  proxyPort = await listen(proxy);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all([api, proxy].map((server) => new Promise((resolve) => server.close(resolve))));
  rmSync(scratch, { recursive: true, force: true });
});

function accountDir({ expiresInMs = 3_600_000, proxyUrl }: { expiresInMs?: number; proxyUrl?: string } = {}): string {
  const dir = mkdtempSync(path.join(scratch, "acc-"));
  writeFileSync(
    path.join(dir, "antigravity-oauth-token"),
    JSON.stringify({
      token: { access_token: TOKEN, token_type: "Bearer", refresh_token: "1//refresh", expiry: new Date(Date.now() + expiresInMs).toISOString(), expires_in: 3599 },
      auth_method: "consumer",
      id_token_email: "two@example.com",
    }),
  );
  if (proxyUrl !== undefined) writeFileSync(path.join(dir, "agy-pool-proxy"), `${proxyUrl}\n`);
  return dir;
}

/** Probes the account the way the pool does, with `agy -p /usage` answering from a live capture. */
async function probe(dir: string): Promise<{ outcome: ProbeOutcome; agyRuns: number }> {
  const acc = readAccount("acc2" as AccountName, dir);
  if (acc.egress.kind === "invalid") throw new Error(acc.egress.problem);
  const route = acc.egress;
  const runPrint = vi.fn(async (): Promise<PrintRun> => ({ kind: "exited", code: 0, stdout: liveAgyUsage, stderr: "" }));
  const outcome = await probeQuota({
    locateBinary: () => "/opt/agy",
    hasAuthToken: () => true,
    readDirect: () => readDirectQuota({ accountDir: dir, route, base: `http://127.0.0.1:${apiPort}` }),
    runPrint,
  });
  return { outcome, agyRuns: runPrint.mock.calls.length };
}

const agyWindows = () => {
  const parsed = parseUsageJson(liveAgyUsage);
  if (!parsed.ok) throw new Error("fixture");
  return toQuotaWindows(parsed.quota);
};

describe("direct quota API", () => {
  it("reads the same windows agy /usage reports (the disabled 5h bucket left out by both) plus the tier, without running agy", async () => {
    const dir = accountDir();
    const { outcome, agyRuns } = await probe(dir);
    expect(agyRuns).toBe(0);
    if (!outcome.ok) throw new Error(JSON.stringify(outcome));
    expect(outcome.reading.tier).toBe("PRO");
    // The two captures were taken seconds apart, so the rolling resets of full buckets differ.
    const withoutRollingReset = (w: { resetsAt: string | null; id: string }) => ({ ...w, resetsAt: w.id.startsWith("3p") ? w.resetsAt : "rolling" });
    expect(outcome.reading.windows.map(withoutRollingReset)).toEqual(agyWindows().map(withoutRollingReset));
    expect(outcome.reading.windows.find((w) => w.id === "3p-weekly")).toMatchObject({ usedPercent: 100, resetsAt: "2026-12-01T07:54:58.000Z" });
    expect(outcome.reading.windows.map((w) => w.id)).not.toContain("3p-5h");

    expect(seen.map((s) => s.path).sort()).toEqual(["/v1internal:loadCodeAssist", "/v1internal:retrieveUserQuotaSummary"]);
    for (const request of seen) {
      expect(request.authorization).toBe(`Bearer ${TOKEN}`);
      expect(request.userAgent).toMatch(/^antigravity\/hub\//);
    }
    expect(JSON.parse(seen.find((s) => s.path.endsWith("loadCodeAssist"))!.body)).toEqual({ metadata: { ideType: "ANTIGRAVITY" } });

    expect(accountUsage(readAccount("acc2" as AccountName, dir), outcome).planLabel).toBe("acc2 · PRO · direct");
  });

  it("never puts the token on a command line", async () => {
    await probe(accountDir());
    const lines = seen.flatMap((s) => s.curlArgv);
    expect(lines.some((line) => line.includes("--config -"))).toBe(true);
    expect(lines.filter((line) => line.includes(TOKEN))).toEqual([]);
  });

  it.each([
    ["ULTRA", { paidTier: { id: "g1-ultra-tier" } }, "acc2 · ULTRA · direct"],
    ["FREE", { currentTier: { id: "free-tier" } }, "acc2 · FREE · direct"],
  ])("maps a %s tier into the badge", async (_, assist, badge) => {
    replies["/v1internal:loadCodeAssist"] = { status: 200, body: JSON.stringify(assist) };
    const dir = accountDir();
    const { outcome } = await probe(dir);
    expect(accountUsage(readAccount("acc2" as AccountName, dir), outcome).planLabel).toBe(badge);
  });

  it("still reads quota when the tier lookup fails, and leaves the tier out of the badge", async () => {
    replies["/v1internal:loadCodeAssist"] = { status: 500, body: "boom" };
    const dir = accountDir();
    const { outcome, agyRuns } = await probe(dir);
    expect(agyRuns).toBe(0);
    expect(outcome.ok && outcome.reading.tier).toBeNull();
    expect(accountUsage(readAccount("acc2" as AccountName, dir), outcome).planLabel).toBe("acc2 · direct");
  });

  it.each([
    ["expired", -1_000],
    ["expiring within a minute", 30_000],
  ])("leaves an %s token to agy, which refreshes it, without calling the API", async (_, expiresInMs) => {
    const { outcome, agyRuns } = await probe(accountDir({ expiresInMs }));
    expect(seen).toEqual([]);
    expect(agyRuns).toBe(1);
    expect(outcome.ok && outcome.reading.windows).toEqual(agyWindows());
  });

  it.each<[string, Reply]>([
    ["401", { status: 401, body: '{"error":{"code":401,"status":"UNAUTHENTICATED"}}' }],
    ["500", { status: 500, body: "backend error" }],
    ["404", { status: 404, body: "not found" }],
    ["unexpected 403", { status: 403, body: '{"error":{"status":"PERMISSION_DENIED"}}' }],
    ["non-JSON 200", { status: 200, body: "<html>" }],
    ["a changed schema", { status: 200, body: JSON.stringify({ quotaGroups: [] }) }],
    ["no usable buckets", { status: 200, body: JSON.stringify({ groups: [{ displayName: "G", buckets: [{ bucketId: "x" }] }] }) }],
  ])("falls back to agy /usage on %s", async (_, reply) => {
    replies["/v1internal:retrieveUserQuotaSummary"] = reply;
    const { outcome, agyRuns } = await probe(accountDir());
    expect(agyRuns).toBe(1);
    expect(outcome.ok && outcome.reading.windows).toEqual(agyWindows());
  });

  it.each([
    ["UNSUPPORTED_LOCATION", /unavailable from this account's IP\/location \(403 UNSUPPORTED_LOCATION\)/],
    ["SUBSCRIPTION_REQUIRED", /Subscription or billing required on this account \(403\)/],
  ])("reports 403 %s at once instead of waiting for agy", async (reason, message) => {
    replies["/v1internal:retrieveUserQuotaSummary"] = {
      status: 403,
      body: JSON.stringify({ error: { code: 403, status: "PERMISSION_DENIED", details: [{ reason }] } }),
    };
    const { outcome, agyRuns } = await probe(accountDir({ proxyUrl: `http://user:${PROXY_PASSWORD}@127.0.0.1:${proxyPort}` }));
    expect(agyRuns).toBe(0);
    expect(outcome).toEqual({ ok: false, failure: { status: "error", message: expect.stringMatching(message) } });
    expect(JSON.stringify(outcome)).not.toContain(TOKEN);
    expect(JSON.stringify(outcome)).not.toContain(PROXY_PASSWORD);
  });

  it("sends both requests through the account's proxy, even when NO_PROXY would exempt the target", async () => {
    vi.stubEnv("NO_PROXY", "*");
    vi.stubEnv("no_proxy", "*");
    const dir = accountDir({ proxyUrl: `http://user:${PROXY_PASSWORD}@127.0.0.1:${proxyPort}` });
    const { outcome, agyRuns } = await probe(dir);
    expect(agyRuns).toBe(0);
    expect(outcome.ok).toBe(true);
    expect(seen).toHaveLength(2);
    expect(seen.every((s) => s.viaProxy)).toBe(true);
    expect(proxied.map((p) => p.proxyAuthorization)).toEqual(Array(2).fill(`Basic ${Buffer.from(`user:${PROXY_PASSWORD}`).toString("base64")}`));
    expect(accountUsage(readAccount("acc2" as AccountName, dir), outcome).planLabel).toBe("acc2 · PRO · proxy");
    expect(seen.flatMap((s) => s.curlArgv).filter((line) => line.includes(PROXY_PASSWORD) || line.includes(TOKEN))).toEqual([]);
  });

  it("fails closed when the proxy is down: no direct request, no agy run, no credentials in the error", async () => {
    const closed = http.createServer();
    const deadPort = await listen(closed);
    await new Promise((resolve) => closed.close(resolve));
    const { outcome, agyRuns } = await probe(accountDir({ proxyUrl: `http://user:${PROXY_PASSWORD}@127.0.0.1:${deadPort}` }));
    expect(seen).toEqual([]);
    expect(agyRuns).toBe(0);
    expect(outcome).toEqual({
      ok: false,
      failure: { status: "error", message: `proxy 127.0.0.1:${deadPort} did not answer; quota was not read.` },
    });
  });
});
