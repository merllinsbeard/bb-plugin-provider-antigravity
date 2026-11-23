import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { listAccountsMethod, readAccountUsageMethod } from "../src/pool-host-contract.ts";

const fakeAgy = fileURLToPath(new URL("./fixtures/home/.local/bin/agy", import.meta.url));

let home: string;
let log: string;
let call: <M extends typeof listAccountsMethod | typeof readAccountUsageMethod>(
  method: M,
  input: M extends typeof readAccountUsageMethod ? { account: string } : Record<string, never>,
) => Promise<any>;

const usageCalls = () =>
  existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter((line) => line.includes("/usage")) : [];

function addAccount(name: string, options: { email?: string; proxy?: string; gemini5hRemaining?: number } = {}) {
  const dir =
    name === "default" ? path.join(home, ".gemini", "antigravity-cli") : path.join(home, ".local", "share", "agy-accounts", name);
  mkdirSync(dir, { recursive: true });
  if (options.email !== undefined)
    writeFileSync(path.join(dir, "antigravity-oauth-token"), JSON.stringify({ auth_method: "consumer", id_token_email: options.email, token: "secret" }));
  if (options.proxy !== undefined) writeFileSync(path.join(dir, "agy-pool-proxy"), options.proxy, { mode: 0o600 });
  if (options.gemini5hRemaining !== undefined) {
    const live = JSON.parse(readFileSync(new URL("./fixtures/usage-live.json", import.meta.url), "utf8"));
    live.command.data.groups[0].buckets[1].remaining_fraction = options.gemini5hRemaining;
    writeFileSync(path.join(dir, "fake-usage.json"), JSON.stringify(live));
  }
}

beforeEach(async () => {
  home = mkdtempSync(path.join(tmpdir(), "agy-host-entry-"));
  log = path.join(home, "calls.log");
  vi.stubEnv("HOME", home);
  vi.stubEnv("BB_ANTIGRAVITY_EXECUTABLE", fakeAgy);
  vi.stubEnv("AGY_FAKE_LOG", log);
  vi.resetModules();
  const { default: entry } = await import("../host.ts");
  const harness = experimental_createHostEntryHarness(entry);
  call = (method, input) => harness.experimental_call(method, input as never);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe("pool host entry", () => {
  it("lists the default account first, then added accounts by name, without running agy", async () => {
    addAccount("default", { email: "me@example.com" });
    addAccount("zeta");
    addAccount("acc2", { email: "two@example.com" });
    expect(await call(listAccountsMethod, {})).toEqual({ accounts: ["default", "acc2", "zeta"] });
    expect(usageCalls()).toEqual([]);
  });

  it("reads only the asked account, headed by its email, badged with its pool name and route", async () => {
    addAccount("default", { email: "me@example.com" });
    addAccount("acc2", { email: "two@example.com", proxy: "http://user:pw@127.0.0.1:9", gemini5hRemaining: 0.9 });

    const read = await call(readAccountUsageMethod, { account: "acc2" });
    expect(read.found).toBe(true);
    expect(read.usage).toMatchObject({ status: "ok", accountEmail: "two@example.com", planLabel: "acc2 · proxy" });
    expect(read.usage.windows.map((window: { label: string; usedPercent: number }) => [window.label, window.usedPercent])).toEqual([
      ["7d · Gemini", 39.9],
      ["5h · Gemini", 10],
      ["7d · Claude/GPT", 0],
      ["5h · Claude/GPT", 0],
      ["7d · Argon", 0],
    ]);
    expect(usageCalls()).toHaveLength(1);
    expect(usageCalls()[0]).toContain("https_proxy=http://user:pw@127.0.0.1:9");

    const direct = await call(readAccountUsageMethod, { account: "default" });
    expect(direct.usage).toMatchObject({ status: "ok", accountEmail: "me@example.com", planLabel: "default · direct" });
  });

  it("names an account that is not signed in and the command that signs it in", async () => {
    addAccount("default", { email: "me@example.com" });
    addAccount("acc3");
    expect(await call(readAccountUsageMethod, { account: "acc3" })).toEqual({
      found: true,
      usage: {
        status: "error",
        plan: null,
        accountEmail: null,
        planLabel: null,
        message: "acc3 is not signed in. Run agy-pool login acc3.",
      },
    });
    expect(usageCalls()).toEqual([]);
  });

  it("names an account whose proxy file is broken", async () => {
    addAccount("acc4", { email: "four@example.com", proxy: "not a url" });
    const read = await call(readAccountUsageMethod, { account: "acc4" });
    expect(read.usage.status).toBe("error");
    expect(read.usage.message).toMatch(/^acc4: agy-pool: /);
    expect(usageCalls()).toEqual([]);
  });

  it("reports an account that is no longer in the pool as not found", async () => {
    addAccount("default", { email: "me@example.com" });
    expect(await call(readAccountUsageMethod, { account: "gone" })).toEqual({ found: false });
  });
});
