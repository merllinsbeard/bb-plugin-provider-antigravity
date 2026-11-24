import type { ProviderQuota, ProviderQuotaBucket, ProviderQuotaGroup } from "../usage/types.ts";
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
/** Stay on an account with an already-running 5h window while its weekly room stays within this band of the fullest account. */
const WEEKLY_BAND = 0.2;

type GroupWindows = { readonly weekly: ProviderQuotaBucket; readonly fiveHour: ProviderQuotaBucket };

export type AccountRoom = {
  readonly usable: boolean;
  readonly weekly: number;
  readonly fiveHour: number;
  readonly active5h: boolean;
};

function limitWindows(group: ProviderQuotaGroup): GroupWindows | null {
  const weekly = group.buckets.find((bucket) => bucket.window === "weekly");
  const fiveHour = group.buckets.find((bucket) => bucket.window === "5h");
  return weekly && fiveHour ? { weekly, fiveHour } : null;
}

/** The 5h+weekly bucket pairs of every metered group, or only of `family`'s group when the model is known. */
function modelGroups(quota: ProviderQuota, family: ModelFamily | null): GroupWindows[] {
  return quota.groups
    .map(limitWindows)
    .filter(
      (pair): pair is GroupWindows =>
        pair !== null &&
        (family === null || (bucketFamily(pair.weekly.bucketId) === family && bucketFamily(pair.fiveHour.bucketId) === family)),
    );
}

export function accountRoom(quota: ProviderQuota | null, family: ModelFamily | null = null): AccountRoom | null {
  const groups = quota === null ? [] : modelGroups(quota, family);
  if (groups.length === 0) return null;
  const usableGroups = groups.filter(
    ({ weekly, fiveHour }) => weekly.remainingFraction > 0 && fiveHour.remainingFraction > 0,
  );
  if (usableGroups.length === 0) return { usable: false, weekly: 0, fiveHour: 0, active5h: false };
  const weekly =
    groups.reduce(
      (sum, { weekly: w, fiveHour: h }) =>
        sum + (w.remainingFraction > 0 && h.remainingFraction > 0 ? Math.max(0, w.remainingFraction) : 0),
      0,
    ) / groups.length;
  const fiveHour = Math.min(...usableGroups.map(({ fiveHour: h }) => Math.max(0, h.remainingFraction)));
  return { usable: true, weekly, fiveHour, active5h: fiveHour < 1 };
}

function usableAgainAt(quota: ProviderQuota, family: ModelFamily | null): string | null {
  const times = modelGroups(quota, family).flatMap(({ weekly, fiveHour }) => {
    const empty = [weekly, fiveHour].filter((bucket) => LIMITS.has(bucket.window) && bucket.remainingFraction <= 0);
    const resets = empty.map((bucket) => bucket.resetsAtIso);
    return resets.length > 0 && resets.every((reset) => reset !== null) ? [resets.sort().at(-1)!] : [];
  });
  return times.sort()[0] ?? null;
}

/**
 * Picks an account for `family` (or across all families when the model is not known yet):
 * weekly quota is the primary budget; within `WEEKLY_BAND` of the fullest account, drain an
 * account whose 5h window is already active instead of waking untouched 5h timers evenly.
 */
export function pickAccount(candidates: readonly Candidate[], family: ModelFamily | null = null): Pick {
  if (candidates.length === 0) return { ok: false, reason: "no-authenticated-account" };
  const evaluated = candidates.map((candidate) => ({ ...candidate, room: accountRoom(candidate.quota, family) }));
  const usable = evaluated.filter((candidate) => candidate.room === null || candidate.room.usable);
  if (usable.length === 0) {
    const resets = evaluated
      .flatMap((candidate) => {
        const at = candidate.quota === null ? null : usableAgainAt(candidate.quota, family);
        return at === null ? [] : [{ account: candidate.name, at }];
      })
      .sort((a, b) => a.at.localeCompare(b.at));
    return { ok: false, reason: "all-exhausted", nearestReset: resets[0] ?? null };
  }
  const knownWeekly = usable.flatMap((candidate) => (candidate.room ? [candidate.room.weekly] : []));
  const weeklyFloor = knownWeekly.length > 0 ? Math.max(...knownWeekly) - WEEKLY_BAND - 1e-9 : 0;
  const [best] = usable.sort((a, b) => {
    const aKnown = a.room !== null ? 1 : 0;
    const bKnown = b.room !== null ? 1 : 0;
    if (aKnown !== bKnown) return bKnown - aKnown;
    if (a.room && b.room) {
      const aTop = a.room.weekly >= weeklyFloor ? 1 : 0;
      const bTop = b.room.weekly >= weeklyFloor ? 1 : 0;
      if (aTop !== bTop) return bTop - aTop;
      if (aTop === 1) {
        const aActive = a.room.active5h ? 1 : 0;
        const bActive = b.room.active5h ? 1 : 0;
        if (aActive !== bActive) return bActive - aActive;
        if (a.room.active5h && a.room.fiveHour !== b.room.fiveHour) return a.room.fiveHour - b.room.fiveHour;
      }
      if (a.room.weekly !== b.room.weekly) return b.room.weekly - a.room.weekly;
    }
    return a.liveThreads - b.liveThreads;
  });
  return { ok: true, account: best!.name };
}
