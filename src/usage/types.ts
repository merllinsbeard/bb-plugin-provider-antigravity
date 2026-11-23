export type QuotaWindowSpan = "weekly" | "5h" | "daily" | "other";

export type ProviderQuotaBucket = {
  readonly bucketId: string;
  readonly name: string;
  readonly window: QuotaWindowSpan;
  readonly remainingFraction: number;
  readonly resetsAtIso: string | null;
};

export type ProviderQuotaGroup = {
  readonly name: string;
  readonly buckets: readonly ProviderQuotaBucket[];
};

export type ProviderQuota = { readonly groups: readonly ProviderQuotaGroup[] };

export type QuotaWindow = {
  readonly id: string;
  readonly kind: "custom";
  readonly label: string;
  readonly usedPercent: number;
  readonly resetsAt: string | null;
};

export type QuotaReading = {
  readonly accountEmail: string | null;
  readonly planLabel: string | null;
  readonly windows: readonly QuotaWindow[];
};

export type ProbeFailure =
  | { readonly status: "not_installed" | "unauthenticated" | "expired" }
  | { readonly status: "error"; readonly message: string };

export type ProbeOutcome =
  | { readonly ok: true; readonly quota: ProviderQuota; readonly reading: QuotaReading }
  | { readonly ok: false; readonly failure: ProbeFailure };
