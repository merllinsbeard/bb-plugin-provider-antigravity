import type { ProviderQuota, ProviderQuotaGroup } from "../usage/types.ts";
import type { AccountName } from "./account.ts";
import { bucketFamily, type ModelFamily } from "./family.ts";

export type Candidate = {
  readonly name: AccountName;
  readonly quota: ProviderQuota | null;
  readonly liveThreads: number;
};

export type Pick =
  | { readonly ok: true; readonly account: AccountName }
  | { readonly ok: false; readonly reason: "no-authenticated-account" }
  | {
      readonly ok: false;
      readonly reason: "all-exhausted";
      readonly nearestReset: { readonly account: AccountName; readonly at: string } | null;
    };

const LIMITS = new Set(["5h", "weekly"]);

function limitBuckets(group: ProviderQuotaGroup) {
  const buckets = group.buckets.filter((bucket) => LIMITS.has(bucket.window));
  const windows = new Set(buckets.map((bucket) => bucket.window));
  return windows.size === LIMITS.size ? buckets : [];
}

/** The 5h+weekly bucket pairs of every metered group, or only of `family`'s group when the model is known. */
function modelGroups(quota: ProviderQuota, family: ModelFamily | null) {
  return quota.groups
    .map(limitBuckets)
    .filter((buckets) => buckets.length > 0 && (family === null || buckets.every((bucket) => bucketFamily(bucket.bucketId) === family)));
}

export function accountScore(quota: ProviderQuota | null, family: ModelFamily | null = null): number | null {
  const groups = quota === null ? [] : modelGroups(quota, family);
  if (groups.length === 0) return null;
  const groupScores = groups.map((buckets) => Math.min(...buckets.map((bucket) => Math.max(0, bucket.remainingFraction))));
  if (Math.max(...groupScores) === 0) return 0;
  return groupScores.reduce((sum, value) => sum + value, 0) / groupScores.length;
}

function usableAgainAt(quota: ProviderQuota, family: ModelFamily | null): string | null {
  const times = modelGroups(quota, family).flatMap((buckets) => {
    const empty = buckets.filter((bucket) => bucket.remainingFraction <= 0);
    const resets = empty.map((bucket) => bucket.resetsAtIso);
    return resets.length > 0 && resets.every((reset) => reset !== null) ? [resets.sort().at(-1)!] : [];
  });
  return times.sort()[0] ?? null;
}

/** Picks the account with the most room for `family`, or across all families when the model is not known yet. */
export function pickAccount(candidates: readonly Candidate[], family: ModelFamily | null = null): Pick {
  if (candidates.length === 0) return { ok: false, reason: "no-authenticated-account" };
  const scored = candidates.map((candidate) => ({ ...candidate, score: accountScore(candidate.quota, family) }));
  const usable = scored.filter((candidate) => candidate.score !== 0);
  if (usable.length === 0) {
    const resets = scored
      .flatMap((candidate) => {
        const at = candidate.quota === null ? null : usableAgainAt(candidate.quota, family);
        return at === null ? [] : [{ account: candidate.name, at }];
      })
      .sort((a, b) => a.at.localeCompare(b.at));
    return { ok: false, reason: "all-exhausted", nearestReset: resets[0] ?? null };
  }
  const rank = (score: number | null) => (score === null ? -1 : score);
  const [best] = usable.sort((a, b) => rank(b.score) - rank(a.score) || a.liveThreads - b.liveThreads);
  return { ok: true, account: best!.name };
}
