import type { z } from "zod";
import type { poolViewSchema } from "../pool-host-contract.ts";
import type { ProbeOutcome, ProviderQuotaGroup } from "../usage/types.ts";
import { groupLabel, round1 } from "../usage/windows.ts";
import { isAuthenticated, isUsable, listAccounts, readAccountEmail, type Account, type PoolPaths } from "./account.ts";
import { liveThreadCounts, readBindings } from "./bindings.ts";
import { pickAccount } from "./pick.ts";

export type PoolView = z.infer<typeof poolViewSchema>;
type PoolAccountView = PoolView["accounts"][number];
type RouteView = PoolAccountView["route"];
type QuotaView = PoolAccountView["quota"];
type WindowView = NonNullable<Extract<QuotaView, { status: "ok" }>["groups"][number]["fiveHour"]>;

export type SnapshotPorts = {
  readonly paths: PoolPaths;
  readonly probe: (account: Account) => Promise<ProbeOutcome>;
  readonly isAlive?: (threadId: string, pid: number) => boolean;
};

function routeView(account: Account): RouteView {
  const { egress } = account;
  if (egress.kind === "proxy") return { kind: "proxy", endpoint: egress.endpoint };
  return egress;
}

function windowView(group: ProviderQuotaGroup, span: "5h" | "weekly"): WindowView | null {
  const bucket = group.buckets.find((candidate) => candidate.window === span);
  if (!bucket) return null;
  return {
    usedPercent: Math.min(100, Math.max(0, round1((1 - bucket.remainingFraction) * 100))),
    resetsAt: bucket.resetsAtIso,
  };
}

function quotaView(outcome: ProbeOutcome): QuotaView {
  if (outcome.ok)
    return {
      status: "ok",
      groups: outcome.quota.groups.map((group) => ({
        name: groupLabel(group.name) || group.name,
        fiveHour: windowView(group, "5h"),
        weekly: windowView(group, "weekly"),
      })),
    };
  const { failure } = outcome;
  switch (failure.status) {
    case "unauthenticated":
      return { status: "signed-out" };
    case "expired":
      return { status: "expired" };
    case "not_installed":
      return { status: "not-installed" };
    case "error":
      return { status: "error", message: failure.message };
  }
}

export async function readPoolSnapshot(ports: SnapshotPorts): Promise<PoolView> {
  const bindings = readBindings(ports.paths.bindingsFile);
  const live = liveThreadCounts(bindings, ports.isAlive);
  const probed: { account: Account; outcome: ProbeOutcome }[] = [];
  for (const account of listAccounts(ports.paths)) probed.push({ account, outcome: await ports.probe(account) });
  const pick = pickAccount(
    probed
      .filter(({ account }) => isUsable(account) && isAuthenticated(account))
      .map(({ account, outcome }) => ({
        name: account.name,
        quota: outcome.ok ? outcome.quota : null,
        liveThreads: live.get(account.name) ?? 0,
      })),
  );
  return {
    next: pick.ok ? pick.account : null,
    accounts: probed.map(({ account, outcome }) => ({
      name: account.name,
      email: readAccountEmail(account),
      route: routeView(account),
      liveThreads: live.get(account.name) ?? 0,
      boundThreads: [...bindings.values()].filter((binding) => binding.account === account.name).length,
      quota: quotaView(outcome),
    })),
  };
}
