import type { ProviderQuota, ProviderQuotaBucket, QuotaWindow } from "./types.js";

const SPAN_LABELS = { weekly: "Weekly", "5h": "5h", daily: "Daily" } as const;

export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function clean(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function groupLabel(name: string): string {
  return clean(name).replace(/\s+models?$/i, "").replace(/\s+and\s+/i, " & ");
}

export function labelFor(groupName: string, bucket: ProviderQuotaBucket): string {
  const span =
    bucket.window === "other" ? clean(bucket.name) || "Limit" : SPAN_LABELS[bucket.window];
  const group = groupLabel(groupName);
  return group ? `${group} · ${span}` : span;
}

export function claimLabel(label: string, taken: Set<string>): string {
  let candidate = label;
  for (let n = 2; taken.has(candidate); n++) candidate = `${label} (${n})`;
  taken.add(candidate);
  return candidate;
}

export function claimId(id: string, taken: Set<string>): string {
  let candidate = id;
  for (let n = 2; taken.has(candidate); n++) candidate = `${id}-${n}`;
  taken.add(candidate);
  return candidate;
}

export function assertUniqueWindows(windows: readonly QuotaWindow[]): void {
  const ids = new Set(windows.map((window) => window.id));
  const labels = new Set(windows.map((window) => window.label));
  if (ids.size !== windows.length || labels.size !== windows.length)
    throw new Error("Quota windows must have unique ids and labels.");
}

export function toQuotaWindows(quota: ProviderQuota): QuotaWindow[] {
  const labels = new Set<string>();
  const ids = new Set<string>();
  const windows = quota.groups.flatMap((group) =>
    group.buckets.map(
      (bucket): QuotaWindow => ({
        id: claimId(bucket.bucketId, ids),
        kind: "custom",
        label: claimLabel(labelFor(group.name, bucket), labels),
        usedPercent: Math.min(100, Math.max(0, round1((1 - bucket.remainingFraction) * 100))),
        resetsAt: bucket.resetsAtIso,
      }),
    ),
  );
  assertUniqueWindows(windows);
  return windows;
}
