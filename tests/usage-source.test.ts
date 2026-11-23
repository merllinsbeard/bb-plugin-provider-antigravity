import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  usageFetchInputSchema,
  usageFetchMethod,
  usageListMethod,
  usageMeasurementSchema,
  usageResourceListSchema,
  usageSourceRpcContract,
} from "../src/usage-contract.ts";
import { listAccountsMethod, poolHostContract, readAccountUsageMethod } from "../src/pool-host-contract.ts";
import { registerUsageSource } from "../src/usage-source.ts";
import { normalizeUsageMeasurement } from "./support/usage-normalization.ts";

type HostUsage = Record<string, unknown>;
type Handlers = Record<string, (input: unknown) => Promise<unknown>>;
type HostCall = { method: string; input: Record<string, unknown>; hostId: string };

const okUsage = (windows: unknown[], account = "default"): HostUsage => ({
  status: "ok",
  accountEmail: `${account}@example.com`,
  planLabel: `${account} · direct`,
  windows,
});

const LIVE_WINDOWS = [
  { id: "gemini-weekly", kind: "custom", model: null, label: "7d · Gemini", usedPercent: 39.9, resetsAt: "2026-11-28T15:54:51.000Z", cost: null },
  { id: "gemini-5h", kind: "custom", model: null, label: "5h · Gemini", usedPercent: 76.3, resetsAt: "2026-11-23T11:13:01.000Z", cost: null },
  { id: "3p-weekly", kind: "custom", model: null, label: "7d · Claude/GPT", usedPercent: 0, resetsAt: "2026-11-30T09:23:21.000Z", cost: null },
  { id: "3p-5h", kind: "custom", model: null, label: "5h · Claude/GPT", usedPercent: 0, resetsAt: "2026-11-23T14:23:21.000Z", cost: null },
  { id: "gemini-argon-wtu-weekly", kind: "custom", model: null, label: "7d · Argon", usedPercent: 0, resetsAt: "2026-11-30T09:23:21.000Z", cost: null },
];

function setup() {
  const state = {
    hosts: [
      { id: "laptop", name: "Laptop", status: "connected" },
      { id: "server", name: "Server", status: "disconnected" },
    ],
    providers: [
      { id: "acp-antigravity", displayName: "Google Antigravity", pluginId: "provider-acp" },
      { id: "antigravity", displayName: "Google Antigravity", pluginId: "provider-antigravity" },
      { id: "antigravity", displayName: "Impostor", pluginId: "someone-else" },
    ],
    accounts: async (): Promise<string[]> => ["default", "acc2"],
    next: (account: string): Promise<HostUsage | null> => Promise.resolve(okUsage(LIVE_WINDOWS, account)),
  };
  const calls: HostCall[] = [];
  const reads = () => calls.filter((call) => call.method === readAccountUsageMethod);
  const hostCall = async (method: string, input: Record<string, unknown>, options: { hostId: string }) => {
    calls.push({ method, input, hostId: options.hostId });
    if (method === listAccountsMethod) return { accounts: await state.accounts() };
    const usage = await state.next(String(input.account));
    return usage === null ? { found: false } : { found: true, usage };
  };
  let handlers: Handlers = {};
  let options: unknown;
  const bb = {
    sdk: {
      hosts: { list: async () => state.hosts },
      providers: { list: async () => state.providers },
    },
    hosts: {
      experimental_client: ({ contract }: { contract: unknown }) => {
        expect(contract).toBe(poolHostContract);
        return { call: hostCall };
      },
    },
    rpc: {
      register: (contract: unknown, impl: Handlers, registerOptions: unknown) => {
        expect(contract).toBe(usageSourceRpcContract);
        handlers = impl;
        options = registerOptions;
      },
    },
  } as unknown as BbPluginApi;
  registerUsageSource(bb);
  const list = async () => usageResourceListSchema.parse(await handlers[usageListMethod]!({}));
  const read = async (refresh = false, account = "default", hostId = "laptop", providerId = "antigravity") =>
    usageMeasurementSchema.parse(
      await handlers[usageFetchMethod]!(
        usageFetchInputSchema.parse({ resourceId: JSON.stringify([hostId, providerId, account]), refresh }),
      ),
    );
  return { state, calls, reads, list, read, options: () => options };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1_000_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Antigravity usage source", () => {
  it("is discoverable with a description", () => {
    expect(setup().options()).toEqual({
      experimental_discoverable: true,
      experimental_description: "Host-local Google Antigravity quota for each pool account, read via the documented agy CLI.",
    });
  });

  it("lists one resource per pool account in the host's order without measuring", async () => {
    const source = setup();
    const resource = (hostId: string, hostName: string, account: string) => ({
      id: JSON.stringify([hostId, "antigravity", account]),
      accountKey: null,
      providerId: "antigravity",
      label: `Google Antigravity · ${account}`,
      scope: { kind: "host", hostId, hostName },
    });
    expect(await source.list()).toEqual({
      resources: [resource("laptop", "Laptop", "default"), resource("laptop", "Laptop", "acc2"), resource("server", "Server", "default")],
    });
    expect(source.calls.map((call) => [call.method, call.hostId])).toEqual([[listAccountsMethod, "laptop"]]);
  });

  it("keeps the last known accounts when the host cannot list them", async () => {
    const source = setup();
    await source.list();
    source.state.accounts = async () => {
      throw new Error("worker crashed");
    };
    const ids = (await source.list()).resources.map((resource) => JSON.parse(resource.id));
    expect(ids).toEqual([
      ["laptop", "antigravity", "default"],
      ["laptop", "antigravity", "acc2"],
      ["server", "antigravity", "default"],
    ]);
  });

  it("reads exactly one account and returns its blocks unchanged", async () => {
    const source = setup();
    const measurement = await source.read(false, "acc2");
    expect(source.reads()).toEqual([{ method: readAccountUsageMethod, input: { account: "acc2" }, hostId: "laptop" }]);
    expect(measurement).toEqual({
      accountKey: null,
      observedAt: 1_000_000,
      usage: { ...okUsage(LIVE_WINDOWS, "acc2"), plan: null },
    });
    const shown = normalizeUsageMeasurement(measurement);
    expect(shown).toEqual(measurement);
  });

  it("serves a cached ok measurement for 60 s unless refresh is requested", async () => {
    const source = setup();
    await source.read();
    vi.setSystemTime(1_000_000 + 59_999);
    expect((await source.read()).observedAt).toBe(1_000_000);
    expect(source.reads()).toHaveLength(1);
    expect((await source.read(true)).observedAt).toBe(1_059_999);
    expect(source.reads()).toHaveLength(2);
    vi.setSystemTime(1_059_999 + 60_000);
    await source.read();
    expect(source.reads()).toHaveLength(3);
  });

  it("shares an in-flight read and starts a fresh one when refresh arrives behind it", async () => {
    const source = setup();
    const releases: Array<() => void> = [];
    source.state.next = (account) => new Promise((resolve) => releases.push(() => resolve(okUsage(LIVE_WINDOWS, account))));
    const first = source.read(false);
    const second = source.read(false);
    const fresh = source.read(true);
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releases[0]!();
    await Promise.all([first, second]);
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases[1]!();
    await fresh;
    expect(source.reads()).toHaveLength(2);
  });

  it("reports a disconnected machine as an error without measuring", async () => {
    const source = setup();
    expect((await source.read(false, "default", "server")).usage).toEqual({
      status: "error",
      plan: null,
      accountEmail: null,
      planLabel: null,
      message: "Machine is disconnected.",
    });
    expect(source.reads()).toEqual([]);
  });

  it("keeps the last successful observedAt when a later read fails", async () => {
    const source = setup();
    await source.read();
    vi.setSystemTime(2_000_000);
    source.state.next = async () => ({ status: "error", accountEmail: null, planLabel: null, message: "default: agy /usage failed: down" });
    expect(await source.read(true)).toEqual({
      accountKey: null,
      observedAt: 1_000_000,
      usage: { status: "error", plan: null, accountEmail: null, planLabel: null, message: "default: agy /usage failed: down" },
    });
    source.state.next = async () => {
      throw new Error("worker crashed");
    };
    expect(await source.read(true)).toMatchObject({
      observedAt: 1_000_000,
      usage: { status: "error", message: "Usage could not be collected from this machine." },
    });
  });

  it("fails a resource whose account left the pool, so the panel relists", async () => {
    const source = setup();
    source.state.next = async () => null;
    await expect(source.read(false, "gone")).rejects.toThrow("no longer exists");
  });

  it("rejects resources that are not this plugin's provider", async () => {
    const source = setup();
    await expect(source.read(false, "default", "laptop", "acp-antigravity")).rejects.toThrow("no longer exists");
    await expect(source.read(false, "default", "gone", "antigravity")).rejects.toThrow("no longer exists");
    source.state.providers = [];
    await expect(source.read()).rejects.toThrow("no longer exists");
  });
});
