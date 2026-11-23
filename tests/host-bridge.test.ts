import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  providerHealthResultSchema,
  providerUsageResultSchema,
} from "@get-bb/plugin-sdk/provider-bridge";
import {
  experimental_createBridgeJsonRpcTestHarness,
  type BridgeJsonRpcTestHarness,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import { antigravityDeclaration } from "../src/declaration.js";

const fakeBin = fileURLToPath(new URL("./fixtures/home/.local/bin/", import.meta.url));
const fakeAgy = path.join(fakeBin, "agy");

const providerOptions = antigravityDeclaration().experimental_bridgeOptions ?? {};

let home: string;
let log: string;
let harness: BridgeJsonRpcTestHarness;
let nextId = 1;

const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []);
const usageCalls = () => calls().filter((call) => call.includes("/usage"));

async function request(method: string) {
  const id = nextId++;
  harness.sendRequest(id, method, {
    providerId: "antigravity",
    providerOptions,
    envVars: { PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}` },
  });
  const response = await harness.waitForResponse(id);
  expect(response).not.toHaveProperty("error");
  return (response as { result: unknown }).result;
}

function signIn() {
  const dir = path.join(home, ".gemini", "antigravity-cli");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "antigravity-oauth-token"), "");
}

beforeEach(async () => {
  home = mkdtempSync(path.join(tmpdir(), "agy-bridge-home-"));
  log = path.join(home, "calls.log");
  vi.stubEnv("HOME", home);
  vi.stubEnv("BB_ANTIGRAVITY_EXECUTABLE", fakeAgy);
  vi.stubEnv("AGY_FAKE_LOG", log);
  vi.resetModules();
  const { experimental_providerBridge } = await import("../host.js");
  harness = experimental_createBridgeJsonRpcTestHarness(experimental_providerBridge.handleLine);
});

afterEach(() => {
  harness.restore();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe("host bridge", () => {
  it("loads without running agy", () => {
    expect(calls()).toEqual([]);
  });

  it("answers provider/usage with the live quota windows", async () => {
    signIn();
    const result = providerUsageResultSchema.parse(await request("provider/usage"));
    expect(result).toEqual({
      supported: true,
      usage: {
        status: "ok",
        accountEmail: null,
        planLabel: null,
        windows: [
          { id: "gemini-weekly", kind: "custom", model: null, label: "Gemini · Weekly", usedPercent: 39.9, resetsAt: "2026-11-28T15:54:51.000Z" },
          { id: "gemini-5h", kind: "custom", model: null, label: "Gemini · 5h", usedPercent: 76.3, resetsAt: "2026-11-23T11:13:01.000Z" },
          { id: "3p-weekly", kind: "custom", model: null, label: "Claude & GPT · Weekly", usedPercent: 0, resetsAt: "2026-11-30T09:23:21.000Z" },
          { id: "3p-5h", kind: "custom", model: null, label: "Claude & GPT · 5h", usedPercent: 0, resetsAt: "2026-11-23T14:23:21.000Z" },
          { id: "gemini-argon-wtu-weekly", kind: "custom", model: null, label: "Gemini 4 Argon · Weekly", usedPercent: 0, resetsAt: "2026-11-30T09:23:21.000Z" },
        ],
      },
    });
    expect(usageCalls()).toEqual(["-p /usage --output-format json --print-timeout 15s|marker="]);
  });

  it("answers provider/health as ready without reading quota", async () => {
    signIn();
    const result = providerHealthResultSchema.parse(await request("provider/health"));
    expect(result).toMatchObject({
      supported: true,
      health: { status: "ready", installedVersion: "1.5.15", loginCommand: "agy acp --login" },
    });
    expect(usageCalls()).toEqual([]);
  });

  it("reports a signed-out machine as unauthenticated without running /usage", async () => {
    expect(providerHealthResultSchema.parse(await request("provider/health"))).toMatchObject({
      health: { status: "unauthenticated" },
    });
    expect(providerUsageResultSchema.parse(await request("provider/usage"))).toEqual({
      supported: true,
      usage: { status: "unauthenticated" },
    });
    expect(usageCalls()).toEqual([]);
  });

  it("reports an expired sign-in when agy asks to authenticate", async () => {
    signIn();
    vi.stubEnv("AGY_FAKE_MODE", "auth");
    expect(providerUsageResultSchema.parse(await request("provider/usage"))).toEqual({
      supported: true,
      usage: { status: "expired" },
    });
  });

  it("shares one agy run between concurrent usage requests", async () => {
    signIn();
    const [a, b] = await Promise.all([request("provider/usage"), request("provider/usage")]);
    expect(a).toEqual(b);
    expect(usageCalls()).toHaveLength(1);
  });
});
