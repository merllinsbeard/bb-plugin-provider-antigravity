import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { poolHostContract, readPoolMethod } from "../src/pool-host-contract.ts";
import { registerPoolPanel } from "../src/pool-panel.ts";
import { poolPanelContract, readPanelMethod } from "../src/pool-panel-contract.ts";

const POOL = {
  next: "acc2",
  accounts: [
    {
      name: "acc2",
      email: "two@example.com",
      route: { kind: "proxy" as const, endpoint: "203.0.113.5:10000" },
      liveThreads: 1,
      boundThreads: 3,
      quota: { status: "ok" as const, groups: [{ name: "Gemini", fiveHour: { usedPercent: 5, resetsAt: null }, weekly: null }] },
    },
  ],
};

function setup() {
  const state = {
    hosts: [
      { id: "server", name: "merlinde", status: "connected" },
      { id: "laptop", name: "MacBook", status: "disconnected" },
      { id: "box", name: "Box", status: "connected" },
    ],
    providers: {
      server: [{ id: "antigravity", pluginId: "provider-antigravity" }],
      laptop: [{ id: "antigravity", pluginId: "provider-antigravity" }],
      box: [{ id: "codex", pluginId: "provider-codex" }],
    } as Record<string, { id: string; pluginId: string }[]>,
    readPool: async (): Promise<unknown> => POOL,
  };
  const calls: string[] = [];
  let handler: (input: { refresh: boolean }) => Promise<{ machines: unknown[] }> = async () => ({ machines: [] });
  const bb = {
    sdk: {
      hosts: { list: async () => state.hosts },
      providers: { list: async ({ hostId }: { hostId: string }) => state.providers[hostId] ?? [] },
    },
    hosts: {
      experimental_client: ({ contract }: { contract: unknown }) => {
        expect(contract).toBe(poolHostContract);
        return {
          call: async (method: string, _input: unknown, options: { hostId: string }) => {
            expect(method).toBe(readPoolMethod);
            calls.push(options.hostId);
            return state.readPool();
          },
        };
      },
    },
    rpc: {
      register: (contract: unknown, impl: Record<string, typeof handler>) => {
        expect(contract).toBe(poolPanelContract);
        handler = impl[readPanelMethod]!;
      },
    },
  } as unknown as BbPluginApi;
  registerPoolPanel(bb);
  const read = (refresh = false) => handler({ refresh });
  return { state, calls, read };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1_000_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("pool panel", () => {
  it("reads the pool only on connected machines that run this provider", async () => {
    const panel = setup();
    expect(await panel.read()).toEqual({
      machines: [{ id: "server", name: "merlinde", observedAt: 1_000_000, pool: POOL, error: null }],
    });
    expect(panel.calls).toEqual(["server"]);
  });

  it("keeps a reading for 60 s unless the panel asks for a fresh one", async () => {
    const panel = setup();
    await panel.read();
    vi.setSystemTime(1_059_999);
    await panel.read();
    expect(panel.calls).toHaveLength(1);
    await panel.read(true);
    expect(panel.calls).toHaveLength(2);
  });

  it("shows the last pool with an error when a later read fails", async () => {
    const panel = setup();
    await panel.read();
    panel.state.readPool = async () => {
      throw new Error("worker crashed");
    };
    vi.setSystemTime(2_000_000);
    expect((await panel.read(true)).machines).toEqual([
      { id: "server", name: "merlinde", observedAt: 1_000_000, pool: POOL, error: "The pool could not be read on this machine." },
    ]);
  });
});
