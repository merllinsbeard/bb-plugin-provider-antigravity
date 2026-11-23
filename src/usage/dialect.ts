import type { AcpDialect } from "@get-bb/plugin-sdk/provider-bridge/acp";
import type { ProviderUsageResult } from "@get-bb/plugin-sdk/provider-bridge";
import { isAuthenticated, type Account } from "../pool/account.ts";
import { withSingleFlight } from "./probe.ts";
import type { ProbeOutcome } from "./types.ts";
import { accountWindows } from "./windows.ts";

type AcpMaintenanceDialect = NonNullable<AcpDialect["maintenance"]>;

export type PoolUsagePorts = {
  readonly locateBinary: () => string | null;
  readonly accounts: () => readonly Account[];
  readonly probe: (account: Account) => Promise<ProbeOutcome>;
};

function toUsageResult(outcome: ProbeOutcome): ProviderUsageResult {
  if (!outcome.ok) {
    const { failure } = outcome;
    return {
      supported: true,
      usage:
        failure.status === "error"
          ? { status: "error", message: failure.message, accountEmail: null, planLabel: null }
          : { status: failure.status },
    };
  }
  const { reading } = outcome;
  return {
    supported: true,
    usage: {
      status: "ok",
      accountEmail: reading.accountEmail,
      planLabel: reading.planLabel,
      windows: reading.windows.map((window) => ({
        id: window.id,
        kind: window.kind,
        model: null,
        label: window.label,
        usedPercent: window.usedPercent,
        resetsAt: window.resetsAt,
      })),
    },
  };
}

async function readPool(ports: PoolUsagePorts): Promise<ProbeOutcome> {
  const accounts = ports.accounts();
  if (accounts.length === 1) return ports.probe(accounts[0]!);
  const outcomes: { account: Account; outcome: ProbeOutcome }[] = [];
  for (const account of accounts) outcomes.push({ account, outcome: await ports.probe(account) });
  const readings = outcomes.flatMap(({ account, outcome }) => (outcome.ok ? [{ account, outcome }] : []));
  if (readings.length === 0) {
    const failures = outcomes.map(({ outcome }) => outcome);
    return failures.find((outcome) => !outcome.ok && outcome.failure.status !== "unauthenticated") ?? failures[0]!;
  }
  return {
    ok: true,
    quota: { groups: readings.flatMap(({ outcome }) => outcome.quota.groups) },
    reading: {
      accountEmail: null,
      planLabel: null,
      windows: readings.flatMap(({ account, outcome }) => accountWindows(account.name, outcome.reading.windows)),
    },
  };
}

export function antigravityMaintenance(ports: PoolUsagePorts): AcpMaintenanceDialect {
  const readQuota = withSingleFlight(() => readPool(ports));
  return {
    loginCommand: "agy acp --login",
    installer: () => ({ command: "agy", args: ["--help"], displayCommand: "agy --help" }),
    readAccount: async () =>
      ports.locateBinary() !== null && ports.accounts().some(isAuthenticated) ? { email: null } : null,
    readUsage: async () => toUsageResult(await readQuota()),
  };
}
