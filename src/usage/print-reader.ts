import { z } from "zod";
import type {
  ProviderQuota,
  ProviderQuotaBucket,
  ProviderQuotaGroup,
  QuotaWindowSpan,
} from "./types.ts";

export type ParseFailure =
  | { readonly kind: "not-expanded" }
  | { readonly kind: "provider-error"; readonly message: string }
  | { readonly kind: "malformed"; readonly detail: string };

export type ParseResult =
  | { readonly ok: true; readonly quota: ProviderQuota }
  | { readonly ok: false; readonly failure: ParseFailure };

const optionalString = z.string().optional().catch(undefined);

const wireBucketSchema = z.object({
  id: optionalString,
  name: optionalString,
  window: optionalString,
  remaining_fraction: z.unknown(),
  reset_time: z.unknown(),
});

const wireGroupSchema = z.object({
  name: z.string(),
  buckets: z.array(z.unknown()).catch([]),
});

const wireEnvelopeSchema = z.object({
  status: optionalString,
  response: optionalString,
  command: z
    .object({
      name: optionalString,
      data: z.object({ groups: z.array(z.unknown()) }).optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
});

const SPANS: ReadonlySet<string> = new Set(["weekly", "5h", "daily"]);

function spanOf(window: string | undefined): QuotaWindowSpan {
  return window !== undefined && SPANS.has(window)
    ? (window as QuotaWindowSpan)
    : "other";
}

function resetIso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function toBucket(
  raw: unknown,
  groupName: string,
  index: number,
): ProviderQuotaBucket | null {
  const parsed = wireBucketSchema.safeParse(raw);
  if (!parsed.success) return null;
  const bucket = parsed.data;
  if (
    typeof bucket.remaining_fraction !== "number" ||
    !Number.isFinite(bucket.remaining_fraction)
  )
    return null;
  return {
    bucketId: bucket.id || `${groupName}:${bucket.name ?? index}`,
    name: bucket.name ?? "",
    window: spanOf(bucket.window),
    remainingFraction: bucket.remaining_fraction,
    resetsAtIso: resetIso(bucket.reset_time),
  };
}

function toGroup(raw: unknown): ProviderQuotaGroup | null {
  const parsed = wireGroupSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { name } = parsed.data;
  const buckets = parsed.data.buckets
    .map((bucket, index) => toBucket(bucket, name, index))
    .filter((bucket) => bucket !== null);
  return buckets.length === 0 ? null : { name, buckets };
}

export function parseUsageJson(stdout: string): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    return { ok: false, failure: { kind: "malformed", detail: "stdout is not JSON" } };
  }
  const envelope = wireEnvelopeSchema.safeParse(json);
  if (!envelope.success)
    return { ok: false, failure: { kind: "malformed", detail: "not a JSON object" } };
  const { status, response, command } = envelope.data;
  if (status !== "SUCCESS")
    return {
      ok: false,
      failure: {
        kind: "provider-error",
        message: response?.trim() || `agy reported status ${status ?? "unknown"}`,
      },
    };
  if (command === undefined) return { ok: false, failure: { kind: "not-expanded" } };
  if (command.name !== "usage")
    return {
      ok: false,
      failure: { kind: "malformed", detail: `unexpected command ${command.name ?? "without a name"}` },
    };
  const groups = (command.data?.groups ?? [])
    .map(toGroup)
    .filter((group) => group !== null);
  if (groups.length === 0)
    return { ok: false, failure: { kind: "malformed", detail: "no usable quota buckets" } };
  return { ok: true, quota: { groups } };
}
