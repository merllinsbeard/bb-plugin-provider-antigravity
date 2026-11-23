import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { isAntigravity } from "./identity.ts";
import { DEFAULT_ACCOUNT } from "./pool/account.ts";
import { listAccountsMethod, poolHostContract, readAccountUsageMethod } from "./pool-host-contract.ts";
import {
  usageFetchMethod,
  usageListMethod,
  usageMeasurementSchema,
  usageSourceRpcContract,
  type UsageMeasurement,
} from "./usage-contract.ts";

const CACHE_TTL_MS = 60_000;
const UNKNOWN_ACCOUNT = { accountEmail: null, planLabel: null };
const HOST_CALL_TIMEOUT_MS = 40_000;
const locatorSchema = z.tuple([z.string().min(1), z.string().min(1), z.string().min(1)]);

export function registerUsageSource(bb: BbPluginApi) {
  const poolHost = bb.hosts.experimental_client({ contract: poolHostContract });
  const knownAccounts = new Map<string, readonly string[]>();
  const cache = new Map<string, UsageMeasurement>();
  const pending = new Map<string, { refresh: boolean; promise: Promise<UsageMeasurement> }>();

  const load = async (resourceId: string, refresh: boolean): Promise<UsageMeasurement> => {
    const [hostId, providerId, account] = locatorSchema.parse(JSON.parse(resourceId));
    const machine = (await bb.sdk.hosts.list()).find((candidate) => candidate.id === hostId);
    if (!machine) throw new Error("Usage resource no longer exists.");
    const previous = cache.get(resourceId);
    const unavailable = (message: string) =>
      usageMeasurementSchema.parse({
        accountKey: null,
        observedAt: previous?.observedAt ?? null,
        usage: { ...UNKNOWN_ACCOUNT, status: "error", message },
      });
    if (machine.status === "disconnected") return unavailable("Machine is disconnected.");
    const providers = await bb.sdk.providers.list({ hostId, capability: "usage" });
    if (!providers.some((provider) => provider.id === providerId && isAntigravity(provider)))
      throw new Error("Usage resource no longer exists.");
    if (
      !refresh &&
      previous?.usage.status === "ok" &&
      previous.observedAt !== null &&
      Date.now() - previous.observedAt < CACHE_TTL_MS
    )
      return previous;
    let read;
    try {
      read = await poolHost.call(readAccountUsageMethod, { account }, { hostId, timeoutMs: HOST_CALL_TIMEOUT_MS });
    } catch {
      return unavailable("Usage could not be collected from this machine.");
    }
    if (!read.found) throw new Error("Usage resource no longer exists.");
    const value = usageMeasurementSchema.parse({
      accountKey: null,
      observedAt: read.usage.status === "ok" ? Date.now() : (previous?.observedAt ?? null),
      usage: read.usage,
    });
    cache.set(resourceId, value);
    return value;
  };

  const poolAccounts = async (machine: { id: string; status: string }): Promise<readonly string[]> => {
    if (machine.status !== "disconnected") {
      try {
        const { accounts } = await poolHost.call(listAccountsMethod, {}, { hostId: machine.id, timeoutMs: HOST_CALL_TIMEOUT_MS });
        knownAccounts.set(machine.id, accounts);
        return accounts;
      } catch {}
    }
    return knownAccounts.get(machine.id) ?? [DEFAULT_ACCOUNT];
  };

  const collect = async (resourceId: string, refresh: boolean): Promise<UsageMeasurement> => {
    const running = pending.get(resourceId);
    if (running) {
      if (!refresh || running.refresh) return running.promise;
      await running.promise.catch(() => undefined);
      return collect(resourceId, refresh);
    }
    const promise = load(resourceId, refresh).finally(() => pending.delete(resourceId));
    pending.set(resourceId, { refresh, promise });
    return promise;
  };

  bb.rpc.register(
    usageSourceRpcContract,
    {
      async [usageListMethod]() {
        const hosts = await bb.sdk.hosts.list();
        const resources = (
          await Promise.all(
            hosts.map(async (machine) => {
              const providers = (await bb.sdk.providers.list({ hostId: machine.id, capability: "usage" })).filter(
                isAntigravity,
              );
              if (providers.length === 0) return [];
              const accounts = await poolAccounts(machine);
              return providers.flatMap((provider) =>
                accounts.map((account) => ({
                  id: JSON.stringify([machine.id, provider.id, account]),
                  accountKey: null,
                  providerId: provider.id,
                  label: `${provider.displayName} · ${account}`,
                  scope: { kind: "host" as const, hostId: machine.id, hostName: machine.name },
                })),
              );
            }),
          )
        ).flat();
        const ids = new Set(resources.map((resource) => resource.id));
        for (const id of cache.keys()) if (!ids.has(id)) cache.delete(id);
        return { resources };
      },
      [usageFetchMethod]: ({ resourceId, refresh }) => collect(resourceId, refresh),
    },
    {
      experimental_discoverable: true,
      experimental_description: "Host-local Google Antigravity quota for each pool account, read via the documented agy CLI.",
    },
  );
}
