import type { UsageMeasurement } from "../usage-contract.ts";

type Usage = UsageMeasurement["usage"];
type Window = Extract<Usage, { status: "ok" }>["windows"][number];

/** agy names a group's weekly bucket `<family>-weekly`; window ids keep that bucket id. */
const WEEKLY = /-weekly$/;

/**
 * Sums each weekly limit over the pool. Accounts share one tier, so the pool's
 * capacity is N equal shares and its use is the mean of the measured accounts.
 * The reset is the earliest one: that is when the pool next gets room back.
 */
export function poolWeeklyTotal(usages: readonly Usage[]): Usage {
  const measured = usages.flatMap((usage) => (usage.status === "ok" ? [usage] : []));
  const fields = {
    plan: null,
    accountEmail: "All accounts",
    planLabel: `${measured.length}/${usages.length} accounts measured`,
  };
  if (measured.length === 0) return { status: "error", ...fields, message: "No pool account could be measured." };
  const byId = new Map<string, Window[]>();
  for (const usage of measured)
    for (const window of usage.windows)
      if (WEEKLY.test(window.id)) byId.set(window.id, [...(byId.get(window.id) ?? []), window]);
  const windows = [...byId.values()].map((same): Window => {
    const resets = same.flatMap((window) => (window.resetsAt === null ? [] : [window.resetsAt])).sort();
    return {
      ...same[0]!,
      usedPercent: Math.round((same.reduce((sum, window) => sum + window.usedPercent, 0) / same.length) * 10) / 10,
      resetsAt: resets[0] ?? null,
      cost: null,
    };
  });
  return { status: "ok", ...fields, windows };
}
