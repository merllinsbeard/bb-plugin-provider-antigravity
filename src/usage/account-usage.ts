import type { z } from "zod";
import { readAccountEmail, type Account } from "../pool/account.ts";
import type { usageSchema } from "../usage-contract.ts";
import type { ProbeOutcome } from "./types.ts";

export type AccountUsage = z.input<typeof usageSchema>;

function badge(account: Account): string {
  return `${account.name} · ${account.egress.kind === "proxy" ? "proxy" : "direct"}`;
}

function failure(account: Account, outcome: Extract<ProbeOutcome, { ok: false }>): AccountUsage {
  const { failure } = outcome;
  const login = `Run agy-pool login ${account.name}.`;
  const fields = { accountEmail: readAccountEmail(account), planLabel: null };
  switch (failure.status) {
    case "not_installed":
      return { status: "not_installed", ...fields };
    case "unauthenticated":
      return { status: "error", ...fields, message: `${account.name} is not signed in. ${login}` };
    case "expired":
      return { status: "error", ...fields, message: `${account.name}: the sign-in expired. ${login}` };
    case "error":
      return { status: "error", ...fields, message: `${account.name}: ${failure.message}` };
  }
}

export function accountUsage(account: Account, outcome: ProbeOutcome): AccountUsage {
  if (!outcome.ok) return failure(account, outcome);
  return {
    status: "ok",
    accountEmail: readAccountEmail(account) ?? account.name,
    planLabel: badge(account),
    windows: outcome.reading.windows.map((window) => ({
      id: window.id,
      kind: window.kind,
      model: null,
      label: window.label,
      usedPercent: window.usedPercent,
      resetsAt: window.resetsAt,
      cost: null,
    })),
  };
}
