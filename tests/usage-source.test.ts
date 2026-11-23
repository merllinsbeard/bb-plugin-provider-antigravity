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
import { registerUsageSource } from "../src/usage-source.ts";
import { normalizeUsageMeasurement } from "./support/usage-normalization.ts";

type HostUsage = Record<string, unknown>;
type Handlers = Record<string, (input: unknown) => Promise<unknown>>;

const okUsage = (windows: unknown[]): HostUsage => ({ status: "ok", accountEmail: null, planLabel: null, windows });

const LIVE_WINDOWS = [
  { id: "gemini-weekly", kind: "custom", model: null, label: "7d · Gemini", usedPercent: 39.9, resetsAt: "2026-11-28T15:54:51.000Z" },
  { id: "gemini-5h", kind: "custom", model: null, label: "5h · Gemini", usedPercent: 76.3, resetsAt: "2026-11-23T11:13:01.000Z" },
  { id: "3p-weekly", kind: "custom", model: null, label: "7d · Claude/GPT", usedPercent: 0, resetsAt: "2026-11-30T09:23:21.000Z" },
  { id: "3p-5h", kind: "custom", model: null, label: "5h · Claude/GPT", usedPercent: 0, resetsAt: "2026-11-23T14:23:21.000Z" },
  { id: "gemini-argon-wtu-weekly", kind: "custom", model: null, label: "7d · Argon", usedPercent: 0, resetsAt: "2026-11-30T09:23:21.000Z" },
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
    next: (): Promise<HostUsage> => Promise.resolve(okUsage(LIVE_WINDOWS)),
  };
  const usageLimits = vi.fn(async (args: { hostId: string; providerId: string; refresh?: boolean }) => ({
    [args.providerId]: await state.next(),
  }));
  let handlers: Handlers = {};
  let options: unknown;
  const bb = {
    sdk: {
      hosts: { list: async () => state.hosts },
      providers: { list: async () => state.providers },
      system: { usageLimits },
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
  const read = async (refresh = false, hostId = "laptop", providerId = "antigravity") =>
    usageMeasurementSchema.parse(
      await handlers[usageFetchMethod]!(
        usageFetchInputSchema.parse({ resourceId: JSON.stringify([hostId, providerId]), refresh }),
      ),
    );
  return { state, usageLimits, list, read, options: () => options };
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
      experimental_description: "Host-local Google Antigravity quota read via the documented agy CLI.",
    });
  });

  it("lists only this plugin's provider on every host without measuring", async () => {
    const source = setup();
    expect(await source.list()).toEqual({
      resources: [
        {
          id: JSON.stringify(["laptop", "antigravity"]),
          accountKey: null,
          providerId: "antigravity",
          label: "Google Antigravity",
          scope: { kind: "host", hostId: "laptop", hostName: "Laptop" },
        },
        {
          id: JSON.stringify(["server", "antigravity"]),
          accountKey: null,
          providerId: "antigravity",
          label: "Google Antigravity",
          scope: { kind: "host", hostId: "server", hostName: "Server" },
        },
      ],
    });
    expect(source.usageLimits).not.toHaveBeenCalled();
  });

  it("returns live windows with provider ids and custom labels that display unchanged", async () => {
    const source = setup();
    const measurement = await source.read();
    expect(source.usageLimits).toHaveBeenCalledWith({ hostId: "laptop", providerId: "antigravity", refresh: false });
    expect(measurement).toEqual({
      accountKey: null,
      observedAt: 1_000_000,
      usage: {
        status: "ok",
        plan: null,
        accountEmail: null,
        planLabel: null,
        windows: LIVE_WINDOWS.map((window) => ({ ...window, cost: null })),
      },
    });
    const shown = normalizeUsageMeasurement(measurement);
    expect(shown).toEqual(measurement);
    if (shown.usage.status !== "ok") throw new Error("expected ok usage");
    const labels = shown.usage.windows.map((window) => window.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("falls back to an index-based window id when the host omits one", async () => {
    const source = setup();
    source.state.next = async () => okUsage([{ label: "7d · Gemini", usedPercent: 10, resetsAt: null }]);
    const measurement = await source.read();
    expect(measurement.usage).toMatchObject({
      windows: [{ id: "0:7d · Gemini", kind: "custom", model: null, label: "7d · Gemini" }],
    });
  });

  it("serves a cached ok measurement for 60 s unless refresh is requested", async () => {
    const source = setup();
    await source.read();
    vi.setSystemTime(1_000_000 + 59_999);
    expect((await source.read()).observedAt).toBe(1_000_000);
    expect(source.usageLimits).toHaveBeenCalledTimes(1);
    expect((await source.read(true)).observedAt).toBe(1_059_999);
    expect(source.usageLimits).toHaveBeenLastCalledWith({ hostId: "laptop", providerId: "antigravity", refresh: true });
    vi.setSystemTime(1_059_999 + 60_000);
    await source.read();
    expect(source.usageLimits).toHaveBeenCalledTimes(3);
  });

  it("shares an in-flight read and upgrades to a fresh read when refresh arrives behind it", async () => {
    const source = setup();
    const releases: Array<() => void> = [];
    source.state.next = () => new Promise((resolve) => releases.push(() => resolve(okUsage(LIVE_WINDOWS))));
    const first = source.read(false);
    const second = source.read(false);
    const fresh = source.read(true);
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releases[0]!();
    await Promise.all([first, second]);
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases[1]!();
    await fresh;
    expect(source.usageLimits.mock.calls.map(([args]) => args.refresh)).toEqual([false, true]);
  });

  it("reports a disconnected machine as an error without measuring", async () => {
    const source = setup();
    expect((await source.read(false, "server")).usage).toEqual({
      status: "error",
      plan: null,
      accountEmail: null,
      planLabel: null,
      message: "Machine is disconnected.",
    });
    expect(source.usageLimits).not.toHaveBeenCalled();
  });

  it("keeps the last successful observedAt when a later read fails", async () => {
    const source = setup();
    await source.read();
    vi.setSystemTime(2_000_000);
    source.state.next = async () => ({ status: "error", accountEmail: null, planLabel: null, message: "agy /usage failed: down" });
    expect(await source.read(true)).toEqual({
      accountKey: null,
      observedAt: 1_000_000,
      usage: { status: "error", plan: null, accountEmail: null, planLabel: null, message: "agy /usage failed: down" },
    });
    source.state.next = async () => {
      throw new Error("bridge crashed");
    };
    expect(await source.read(true)).toMatchObject({
      observedAt: 1_000_000,
      usage: { status: "error", message: "Usage could not be collected from this machine." },
    });
  });

  it.each(["not_installed", "unauthenticated", "expired"])("passes the %s state through", async (status) => {
    const source = setup();
    source.state.next = async () => ({ status });
    expect(await source.read()).toEqual({
      accountKey: null,
      observedAt: null,
      usage: { status, plan: null, accountEmail: null, planLabel: null },
    });
  });

  it("rejects resources that are not this plugin's provider", async () => {
    const source = setup();
    await expect(source.read(false, "laptop", "acp-antigravity")).rejects.toThrow("no longer exists");
    await expect(source.read(false, "gone", "antigravity")).rejects.toThrow("no longer exists");
    source.state.providers = [];
    await expect(source.read()).rejects.toThrow("no longer exists");
  });
});
