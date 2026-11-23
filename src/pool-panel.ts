import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { isAntigravity } from "./identity.ts";
import { poolHostContract, readPoolMethod } from "./pool-host-contract.ts";
import { poolPanelContract, readPanelMethod, type MachinePool } from "./pool-panel-contract.ts";

const CACHE_TTL_MS = 60_000;
const READ_POOL_TIMEOUT_MS = 120_000;

type Machine = { readonly id: string; readonly name: string };

export function registerPoolPanel(bb: BbPluginApi) {
  const poolHost = bb.hosts.experimental_client({ contract: poolHostContract });
  const cache = new Map<string, MachinePool>();
  const pending = new Map<string, Promise<MachinePool>>();

  const read = async (machine: Machine): Promise<MachinePool> => {
    const previous = cache.get(machine.id);
    try {
      const pool = await poolHost.call(readPoolMethod, {}, { hostId: machine.id, timeoutMs: READ_POOL_TIMEOUT_MS });
      const value = { id: machine.id, name: machine.name, observedAt: Date.now(), pool, error: null };
      cache.set(machine.id, value);
      return value;
    } catch {
      return {
        id: machine.id,
        name: machine.name,
        observedAt: previous?.observedAt ?? null,
        pool: previous?.pool ?? null,
        error: "The pool could not be read on this machine.",
      };
    }
  };

  const collect = (machine: Machine, refresh: boolean): Promise<MachinePool> => {
    const cached = cache.get(machine.id);
    if (!refresh && cached?.observedAt != null && Date.now() - cached.observedAt < CACHE_TTL_MS) return Promise.resolve(cached);
    const running = pending.get(machine.id);
    if (running) return running;
    const promise = read(machine).finally(() => pending.delete(machine.id));
    pending.set(machine.id, promise);
    return promise;
  };

  bb.rpc.register(poolPanelContract, {
    async [readPanelMethod]({ refresh }) {
      const hosts = (await bb.sdk.hosts.list()).filter((host) => host.status === "connected");
      const machines = await Promise.all(
        hosts.map(async (host) => {
          const providers = await bb.sdk.providers.list({ hostId: host.id, capability: "usage" }).catch(() => []);
          return providers.some(isAntigravity) ? collect({ id: host.id, name: host.name }, refresh) : null;
        }),
      );
      return { machines: machines.filter((machine) => machine !== null) };
    },
  });
}
