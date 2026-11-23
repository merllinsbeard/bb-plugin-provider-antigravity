import type { AcpDialect } from "@get-bb/plugin-sdk/provider-bridge/acp";
import type { ProviderUsageResult } from "@get-bb/plugin-sdk/provider-bridge";
import { probeQuota, withSingleFlight, type ProbePorts } from "./probe.js";
import type { ProbeOutcome } from "./types.js";

type AcpMaintenanceDialect = NonNullable<AcpDialect["maintenance"]>;

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

export function antigravityMaintenance(ports: ProbePorts): AcpMaintenanceDialect {
  const readQuota = withSingleFlight(() => probeQuota(ports));
  return {
    loginCommand: "agy acp --login",
    installer: () => ({ command: "agy", args: ["--help"], displayCommand: "agy --help" }),
    readAccount: async () =>
      ports.locateBinary() !== null && ports.hasAuthToken() ? { email: null } : null,
    readUsage: async () => toUsageResult(await readQuota()),
  };
}
