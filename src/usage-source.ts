import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { ANTIGRAVITY } from "./identity.js";
import {
  usageFetchMethod,
  usageListMethod,
  usageMeasurementSchema,
  usageSourceRpcContract,
  type UsageMeasurement,
} from "./usage-contract.js";

const CACHE_TTL_MS = 60_000;
const UNKNOWN_ACCOUNT = { accountEmail: null, planLabel: null };
const locatorSchema = z.tuple([z.string().min(1), z.string().min(1)]);

function isAntigravity(provider: { id: string; pluginId?: string | null }): boolean {
  return provider.pluginId === ANTIGRAVITY.pluginId && provider.id === ANTIGRAVITY.providerId;
}

export function registerUsageSource(bb: BbPluginApi) {
  const cache = new Map<string, UsageMeasurement>();
  const pending = new Map<string, { refresh: boolean; promise: Promise<UsageMeasurement> }>();

  const load = async (resourceId: string, refresh: boolean): Promise<UsageMeasurement> => {
    const [hostId, providerId] = locatorSchema.parse(JSON.parse(resourceId));
    const host = (await bb.sdk.hosts.list()).find((host) => host.id === hostId);
    if (!host) throw new Error("Usage resource no longer exists.");
    const previous = cache.get(resourceId);
    const unavailable = (message: string) =>
      usageMeasurementSchema.parse({
        accountKey: null,
        observedAt: previous?.observedAt ?? null,
        usage: { ...UNKNOWN_ACCOUNT, status: "error", message },
      });
    if (host.status === "disconnected") return unavailable("Machine is disconnected.");
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
    try {
      const usage = (await bb.sdk.system.usageLimits({ hostId, providerId, refresh }))[providerId];
      if (!usage) throw new Error("Provider returned no usage information.");
      const value = usageMeasurementSchema.parse({
        accountKey: null,
        observedAt: usage.status === "ok" ? Date.now() : (previous?.observedAt ?? null),
        usage: {
          ...UNKNOWN_ACCOUNT,
          ...usage,
          plan: null,
          ...(usage.status === "ok"
            ? {
                windows: usage.windows.map((window, index) => ({
                  ...window,
                  kind: "custom",
                  model: null,
                  id: typeof window.id === "string" && window.id ? window.id : `${index}:${window.label}`,
                  cost: window.cost ?? null,
                })),
              }
            : {}),
        },
      });
      cache.set(resourceId, value);
      return value;
    } catch {
      return unavailable("Usage could not be collected from this machine.");
    }
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
            hosts.map(async (host) =>
              (await bb.sdk.providers.list({ hostId: host.id, capability: "usage" }))
                .filter(isAntigravity)
                .map((provider) => ({
                  id: JSON.stringify([host.id, provider.id]),
                  accountKey: null,
                  providerId: provider.id,
                  label: provider.displayName,
                  scope: { kind: "host" as const, hostId: host.id, hostName: host.name },
                })),
            ),
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
      experimental_description: "Host-local Google Antigravity quota read via the documented agy CLI.",
    },
  );
}
