import { readFileSync } from "node:fs";
import path from "node:path";
import { sanitizeInheritedChildProcessEnv } from "@get-bb/plugin-sdk/provider-bridge";
import { experimental_spawnHostProcess } from "@get-bb/plugin-sdk/process";
import { z } from "zod";
import { AGY_TOKEN_FILE } from "../identity.ts";
import type { Route } from "../pool/egress.ts";
import { parseQuotaGroups } from "./print-reader.ts";
import type { ProviderQuota, Tier } from "./types.ts";

/**
 * Reads quota straight from the endpoint `agy /usage` calls, in one HTTPS
 * request through the account's own route. Anything this reader cannot vouch
 * for (stale token, 401, network trouble, a reply it does not understand)
 * answers `fallback`, so the caller asks `agy -p /usage`, which refreshes the
 * token itself. Only answers that agy would repeat more slowly are final.
 */
export type DirectRead =
  | { readonly kind: "read"; readonly quota: ProviderQuota; readonly tier: Tier | null }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "fallback" };

type Exchange =
  | { readonly kind: "response"; readonly status: number; readonly body: string }
  | { readonly kind: "proxy-down" }
  | { readonly kind: "failed" };

const API_BASE = "https://daily-cloudcode-pa.googleapis.com";
const USER_AGENT = "antigravity/hub/2.33.0 (aidev_client; os_type=linux; arch=amd64; cl=1023160026)";
const EXPIRY_MARGIN_MS = 60_000;
const MAX_TIME_S = 8;
const MAX_BODY_BYTES = 1024 * 1024;
/** curl exit codes that, with a proxy configured, mean the proxy itself did not answer. */
const PROXY_DOWN_EXITS: ReadonlySet<number> = new Set([5, 7, 97]);

const tokenFileSchema = z.object({
  token: z.object({ access_token: z.string().min(1), expiry: z.string() }),
});

/** The access token when it stays valid for at least another minute, else null. */
function readFreshAccessToken(accountDir: string): string | null {
  try {
    const parsed = tokenFileSchema.safeParse(JSON.parse(readFileSync(path.join(accountDir, AGY_TOKEN_FILE), "utf8")));
    if (!parsed.success) return null;
    const expiry = Date.parse(parsed.data.token.expiry);
    return Number.isFinite(expiry) && expiry > Date.now() + EXPIRY_MARGIN_MS ? parsed.data.token.access_token : null;
  } catch {
    return null;
  }
}

const quotaReplySchema = z.object({
  groups: z.array(
    z.object({
      displayName: z.string(),
      buckets: z.array(z.record(z.string(), z.unknown())).catch([]),
    }),
  ),
});

/** Same groups in agy's snake_case shape, so both sources share one parser. */
function parseQuotaReply(body: string): ProviderQuota | null {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  const reply = quotaReplySchema.safeParse(json);
  if (!reply.success) return null;
  return parseQuotaGroups(
    reply.data.groups.map((group) => ({
      name: group.displayName,
      buckets: group.buckets.map((bucket) => ({
        id: bucket.bucketId,
        name: bucket.displayName,
        window: bucket.window,
        remaining_fraction: bucket.remainingFraction,
        reset_time: bucket.resetTime,
        disabled: bucket.disabled,
      })),
    })),
  );
}

const TIERS: readonly (readonly [RegExp, Tier])[] = [
  [/ULTRA/, "ULTRA"],
  [/ENTERPRISE|PAYGO/, "ENTERPRISE"],
  [/PRO|PREMIUM|STANDARD/, "PRO"],
];

const assistReplySchema = z.object({
  paidTier: z.object({ id: z.string() }).optional().catch(undefined),
  currentTier: z.object({ id: z.string() }).optional().catch(undefined),
});

function parseTier(exchange: Exchange): Tier | null {
  if (exchange.kind !== "response" || exchange.status !== 200) return null;
  let json: unknown;
  try {
    json = JSON.parse(exchange.body);
  } catch {
    return null;
  }
  const reply = assistReplySchema.safeParse(json);
  const id = reply.success ? (reply.data.paidTier?.id ?? reply.data.currentTier?.id) : undefined;
  if (id === undefined) return null;
  const upper = id.toUpperCase();
  return TIERS.find(([pattern]) => pattern.test(upper))?.[1] ?? "FREE";
}

function classifyQuota(exchange: Exchange, route: Route, tier: Tier | null): DirectRead {
  if (exchange.kind === "proxy-down" && route.kind === "proxy")
    return { kind: "error", message: `proxy ${route.endpoint} did not answer; quota was not read.` };
  if (exchange.kind !== "response") return { kind: "fallback" };
  if (exchange.status === 403 && exchange.body.includes("UNSUPPORTED_LOCATION"))
    return {
      kind: "error",
      message: "Google Antigravity is unavailable from this account's IP/location (403 UNSUPPORTED_LOCATION).",
    };
  if (exchange.status === 403 && exchange.body.includes("SUBSCRIPTION_REQUIRED"))
    return { kind: "error", message: "Subscription or billing required on this account (403)." };
  if (exchange.status !== 200) return { kind: "fallback" };
  const quota = parseQuotaReply(exchange.body);
  return quota === null ? { kind: "fallback" } : { kind: "read", quota, tier };
}

/** A curl config string: quoted, with the escapes curl reads back. */
function configValue(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error("curl config value must stay on one line");
  return `"${value.replace(/[\\"]/g, "\\$&")}"`;
}

/** curl resolves names itself for socks5://; socks5h:// leaves it to the proxy, as agy does. */
function curlProxyUrl(url: string): string {
  return url.replace(/^socks5:\/\//i, "socks5h://");
}

/**
 * Secrets (bearer token, proxy credentials) go on curl's stdin, never argv,
 * so `/proc/<pid>/cmdline` shows none. `--disable` skips ~/.curlrc; with a
 * proxy, `noproxy = ""` stops a NO_PROXY in the environment from routing
 * around it.
 */
function curlConfig(route: Route, url: string, accessToken: string, body: unknown): string {
  const lines = [
    `url = ${configValue(url)}`,
    `header = ${configValue(`Authorization: Bearer ${accessToken}`)}`,
    `header = "Content-Type: application/json"`,
    `header = ${configValue(`User-Agent: ${USER_AGENT}`)}`,
    `data = ${configValue(JSON.stringify(body))}`,
    `write-out = "\\n%{http_code}"`,
  ];
  if (route.kind === "proxy") lines.push(`proxy = ${configValue(curlProxyUrl(route.url))}`, `noproxy = ""`);
  return `${lines.join("\n")}\n`;
}

function curlPost(route: Route, url: string, accessToken: string, body: unknown): Promise<Exchange> {
  return new Promise<Exchange>((resolve) => {
    let config: string;
    try {
      config = curlConfig(route, url, accessToken, body);
    } catch {
      resolve({ kind: "failed" });
      return;
    }
    let child: ReturnType<typeof experimental_spawnHostProcess>;
    try {
      child = experimental_spawnHostProcess(
        "curl",
        ["--disable", "--silent", "--max-time", String(MAX_TIME_S), "--config", "-"],
        { stdio: ["pipe", "pipe", "ignore"], env: sanitizeInheritedChildProcessEnv({ env: process.env }) },
      );
    } catch {
      resolve({ kind: "failed" });
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (exchange: Exchange) => {
      if (settled) return;
      settled = true;
      resolve(exchange);
    };
    child.stdout!.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        child.kill("SIGKILL");
        finish({ kind: "failed" });
      } else chunks.push(chunk);
    });
    child.on("error", () => finish({ kind: "failed" }));
    child.on("close", (code) => {
      if (code !== 0)
        return finish(route.kind === "proxy" && code !== null && PROXY_DOWN_EXITS.has(code) ? { kind: "proxy-down" } : { kind: "failed" });
      const out = Buffer.concat(chunks).toString("utf8");
      const cut = out.lastIndexOf("\n");
      const status = Number(out.slice(cut + 1));
      finish(Number.isInteger(status) && status > 0 ? { kind: "response", status, body: out.slice(0, cut) } : { kind: "failed" });
    });
    child.stdin!.on("error", () => {});
    child.stdin!.end(config);
  });
}

export async function readDirectQuota({
  accountDir,
  route,
  base = API_BASE,
}: {
  readonly accountDir: string;
  readonly route: Route;
  /** Overridable so tests can point at a local server. */
  readonly base?: string;
}): Promise<DirectRead> {
  const token = readFreshAccessToken(accountDir);
  if (token === null) return { kind: "fallback" };
  const [quota, assist] = await Promise.all([
    curlPost(route, `${base}/v1internal:retrieveUserQuotaSummary`, token, {}),
    curlPost(route, `${base}/v1internal:loadCodeAssist`, token, { metadata: { ideType: "ANTIGRAVITY" } }),
  ]);
  return classifyQuota(quota, route, parseTier(assist));
}
