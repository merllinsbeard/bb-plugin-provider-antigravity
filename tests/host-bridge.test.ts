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
import { antigravityDeclaration } from "../src/declaration.ts";

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
  const { experimental_providerBridge } = await import("../host.ts");
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
          { id: "gemini-weekly", kind: "custom", model: null, label: "7d · Gemini", usedPercent: 39.9, resetsAt: "2026-11-28T15:54:51.000Z" },
          { id: "gemini-5h", kind: "custom", model: null, label: "5h · Gemini", usedPercent: 76.3, resetsAt: "2026-11-23T11:13:01.000Z" },
          { id: "3p-weekly", kind: "custom", model: null, label: "7d · Claude/GPT", usedPercent: 0, resetsAt: "2026-11-30T09:23:21.000Z" },
          { id: "3p-5h", kind: "custom", model: null, label: "5h · Claude/GPT", usedPercent: 0, resetsAt: "2026-11-23T14:23:21.000Z" },
          { id: "gemini-argon-wtu-weekly", kind: "custom", model: null, label: "7d · Argon", usedPercent: 0, resetsAt: "2026-11-30T09:23:21.000Z" },
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

  it("reports every signed-in account with its name on each window", async () => {
    signIn();
    const alt = path.join(home, ".local", "share", "agy-accounts", "alt");
    mkdirSync(alt, { recursive: true });
    writeFileSync(path.join(alt, "antigravity-oauth-token"), "");
    const live = JSON.parse(readFileSync(new URL("./fixtures/usage-live.json", import.meta.url), "utf8"));
    live.command.data.groups[0].buckets[1].remaining_fraction = 0.9;
    writeFileSync(path.join(alt, "fake-usage.json"), JSON.stringify(live));
    mkdirSync(path.join(home, ".local", "share", "agy-accounts", "empty"));

    const result = providerUsageResultSchema.parse(await request("provider/usage"));
    if (!result.supported || result.usage.status !== "ok") throw new Error(`usage not ok: ${JSON.stringify(result)}`);
    const rows = result.usage.windows.map((window) => [window.id, window.label, window.usedPercent]);
    expect(rows).toEqual([
      ["default:gemini-weekly", "default 7d · Gemini", 39.9],
      ["default:gemini-5h", "default 5h · Gemini", 76.3],
      ["default:3p-weekly", "default 7d · Claude/GPT", 0],
      ["default:3p-5h", "default 5h · Claude/GPT", 0],
      ["default:gemini-argon-wtu-weekly", "default 7d · Argon", 0],
      ["alt:gemini-weekly", "alt 7d · Gemini", 39.9],
      ["alt:gemini-5h", "alt 5h · Gemini", 10],
      ["alt:3p-weekly", "alt 7d · Claude/GPT", 0],
      ["alt:3p-5h", "alt 5h · Claude/GPT", 0],
      ["alt:gemini-argon-wtu-weekly", "alt 7d · Argon", 0],
    ]);
    expect(usageCalls()).toHaveLength(2);
  });

  it("shares one agy run between concurrent usage requests", async () => {
    signIn();
    const [a, b] = await Promise.all([request("provider/usage"), request("provider/usage")]);
    expect(a).toEqual(b);
    expect(usageCalls()).toHaveLength(1);
  });

  it("declares user and project native skill roots for BB composer and skill list", () => {
    expect(antigravityDeclaration().experimental_nativeSkillRoots).toEqual({
      user: [{ path: ".agents/skills" }, { path: ".gemini/antigravity/skills" }, { path: ".gemini/skills" }],
      project: [
        { path: ".agents/skills", ancestors: true },
        { path: ".gemini/skills", ancestors: true },
      ],
    });
  });
});
