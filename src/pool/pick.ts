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
/** A weekly window that resets within this time burns first, so its remaining room is not lost at the reset. */
export const EXPIRING_SOON_MS = 48 * 3600 * 1000;
/** Below this much weekly room an expiring window is not worth chasing. */
export const EXPIRING_MIN_WEEKLY = 0.05;
/** This many live threads on one account burn its 5h window together, so the next thread goes elsewhere. */
export const MAX_ACTIVE_LIVE_THREADS = 2;
/** Below this much 5h room even one live thread is enough to send the next thread elsewhere. */
export const LOW_5H_CONCURRENCY_THRESHOLD = 0.25;

type GroupWindows = { readonly weekly: ProviderQuotaBucket; readonly fiveHour: ProviderQuotaBucket };

export type AccountRoom = {
  readonly usable: boolean;
  /** Remaining weekly fraction, 0..1. */
  readonly weekly: number;
  /** Remaining 5h fraction, 0..1. */
  readonly fiveHour: number;
  /** The 5h window already started (`fiveHour < 1`). */
  readonly active5h: boolean;
  /** Earliest real weekly reset of the usable groups counted; agy reports an unset reset as the epoch, which is ignored. */
  readonly weeklyResetsAtMs: number | null;
  /** For a known family: another metered group on this account still has room, so it could serve other threads. */
  readonly otherFamilyUsable: boolean;
};

function limitWindows(group: ProviderQuotaGroup): GroupWindows | null {
  const weekly = group.buckets.find((bucket) => bucket.window === "weekly");
  const fiveHour = group.buckets.find((bucket) => bucket.window === "5h");
  return weekly && fiveHour ? { weekly, fiveHour } : null;
}

const pairFamily = (pair: GroupWindows): string | null => {
  const family = bucketFamily(pair.weekly.bucketId);
  return bucketFamily(pair.fiveHour.bucketId) === family ? family : null;
};

const hasRoom = ({ weekly, fiveHour }: GroupWindows) => weekly.remainingFraction > 0 && fiveHour.remainingFraction > 0;

function meteredGroups(quota: ProviderQuota): GroupWindows[] {
  return quota.groups.map(limitWindows).filter((pair): pair is GroupWindows => pair !== null);
}

/** The 5h+weekly bucket pairs of every metered group, or only of `family`'s group when the model is known. */
function modelGroups(quota: ProviderQuota, family: ModelFamily | null): GroupWindows[] {
  return meteredGroups(quota).filter((pair) => family === null || pairFamily(pair) === family);
}

function resetMs(bucket: ProviderQuotaBucket): number | null {
  const ms = bucket.resetsAtIso === null ? NaN : Date.parse(bucket.resetsAtIso);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

export function accountRoom(quota: ProviderQuota | null, family: ModelFamily | null = null): AccountRoom | null {
  if (family === null && quota !== null) {
    // The model is not known yet and agy opens sessions on Gemini, so a small
    // Claude/GPT group must not drag the account down. All groups count only
    // when Gemini has no room, so the account can still take a Claude/GPT thread.
    const gemini = accountRoom(quota, "gemini");
    if (gemini?.usable) return gemini;
  }
  const groups = quota === null ? [] : modelGroups(quota, family);
  if (groups.length === 0) return null;
  const otherFamilyUsable = family !== null && meteredGroups(quota!).some((pair) => pairFamily(pair) !== family && hasRoom(pair));
  const usableGroups = groups.filter(hasRoom);
  if (usableGroups.length === 0)
    return { usable: false, weekly: 0, fiveHour: 0, active5h: false, weeklyResetsAtMs: null, otherFamilyUsable };
  const weekly = usableGroups.reduce((sum, { weekly: w }) => sum + Math.max(0, w.remainingFraction), 0) / groups.length;
  const fiveHour = Math.min(...usableGroups.map(({ fiveHour: h }) => Math.max(0, h.remainingFraction)));
  const resets = usableGroups.flatMap(({ weekly: w }) => resetMs(w) ?? []);
  const weeklyResetsAtMs = resets.length > 0 ? Math.min(...resets) : null;
  return { usable: true, weekly, fiveHour, active5h: fiveHour < 1, weeklyResetsAtMs, otherFamilyUsable };
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
 * Where an account with known room stands, best first:
 * - `expiring`: its weekly window resets within `EXPIRING_SOON_MS` with more than
 *   `EXPIRING_MIN_WEEKLY` left, so room not spent now is lost at the reset;
 * - `band`: weekly room within `WEEKLY_BAND` of the fullest account;
 * - `behind`: further behind on weekly room.
 */
type Tier = "expiring" | "band" | "behind";
type Ranked = { readonly room: AccountRoom; readonly liveThreads: number };
const TIER_ORDER: Record<Tier | "unknown", number> = { expiring: 0, band: 1, behind: 2, unknown: 3 };

/**
 * Live threads already burning the account's 5h window hard enough that a new
 * thread should open another account, or 0 when there is room for one more.
 * Without it a burst of threads all lands on the most-drained account and hits
 * its 5h limit together.
 */
function crowding({ room, liveThreads }: Ranked): number {
  const saturated = liveThreads >= MAX_ACTIVE_LIVE_THREADS || (liveThreads >= 1 && room.fiveHour < LOW_5H_CONCURRENCY_THRESHOLD);
  return saturated ? liveThreads : 0;
}

/** Sort key, compared element by element, lower first. */
function rankKey(ranked: Ranked, tier: Tier, family: ModelFamily | null): number[] {
  const { room } = ranked;
  // An uncrowded account first; among crowded ones, the one with fewer live threads.
  const crowd = crowding(ranked);
  const startedFirst = room.active5h ? 0 : 1;
  // An active window drains lowest-first so it finishes and the 5h timers stay staggered.
  const drain = room.active5h ? room.fiveHour : 0;
  switch (tier) {
    case "expiring":
      return [TIER_ORDER.expiring, crowd, room.weeklyResetsAtMs!, startedFirst, drain, -room.weekly];
    case "band": {
      // Opening a fresh 5h window: use an account that can serve only this family
      // before waking one that other families still need.
      const keepsOthers = !room.active5h && family !== null && room.otherFamilyUsable ? 1 : 0;
      return [TIER_ORDER.band, crowd, startedFirst, drain, keepsOthers, -room.weekly];
    }
    case "behind":
      return [TIER_ORDER.behind, -room.weekly];
  }
}

function compareKeys(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Picks an account for `family` (or across all families when the model is not known yet).
 * Accounts with known room rank before unknown ones, by `rankKey`; fewer live threads break ties.
 */
export function pickAccount(candidates: readonly Candidate[], family: ModelFamily | null = null, now: Date = new Date()): Pick {
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
  const nowMs = now.getTime();
  const knownWeekly = usable.flatMap((candidate) => (candidate.room ? [candidate.room.weekly] : []));
  const weeklyFloor = knownWeekly.length > 0 ? Math.max(...knownWeekly) - WEEKLY_BAND - 1e-9 : 0;
  const tierOf = (room: AccountRoom): Tier => {
    const resets = room.weeklyResetsAtMs;
    if (resets !== null && resets > nowMs && resets - nowMs <= EXPIRING_SOON_MS && room.weekly > EXPIRING_MIN_WEEKLY) return "expiring";
    return room.weekly >= weeklyFloor ? "band" : "behind";
  };
  // Unknown quota ranks after every known one.
  const key = ({ room, liveThreads }: (typeof usable)[number]) =>
    room === null ? [TIER_ORDER.unknown] : rankKey({ room, liveThreads }, tierOf(room), family);
  const [best] = usable
    .map((candidate) => ({ candidate, key: key(candidate) }))
    .sort((a, b) => compareKeys(a.key, b.key) || a.candidate.liveThreads - b.candidate.liveThreads);
  return { ok: true, account: best!.candidate.name };
}
