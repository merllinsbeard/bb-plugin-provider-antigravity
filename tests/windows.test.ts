import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseUsageJson } from "../src/usage/print-reader.js";
import type { ProviderQuota, ProviderQuotaBucket, QuotaWindow } from "../src/usage/types.js";
import { assertUniqueWindows, toQuotaWindows } from "../src/usage/windows.js";

function liveQuota(): ProviderQuota {
  const result = parseUsageJson(
    readFileSync(new URL("./fixtures/usage-live.json", import.meta.url), "utf8"),
  );
  if (!result.ok) throw new Error("live fixture must parse");
  return result.quota;
}

function bucket(overrides: Partial<ProviderQuotaBucket>): ProviderQuotaBucket {
  return {
    bucketId: "b",
    name: "Limit",
    window: "weekly",
    remainingFraction: 0.5,
    resetsAtIso: null,
    ...overrides,
  };
}

describe("toQuotaWindows", () => {
  it("turns the live fixture into five unique custom windows in provider order", () => {
    expect(toQuotaWindows(liveQuota())).toEqual([
      { id: "gemini-weekly", kind: "custom", label: "7d · Gemini", usedPercent: 39.9, resetsAt: "2026-11-28T15:54:51.000Z" },
      { id: "gemini-5h", kind: "custom", label: "5h · Gemini", usedPercent: 76.3, resetsAt: "2026-11-23T11:13:01.000Z" },
      { id: "3p-weekly", kind: "custom", label: "7d · Claude/GPT", usedPercent: 0, resetsAt: "2026-11-30T09:23:21.000Z" },
      { id: "3p-5h", kind: "custom", label: "5h · Claude/GPT", usedPercent: 0, resetsAt: "2026-11-23T14:23:21.000Z" },
      { id: "gemini-argon-wtu-weekly", kind: "custom", label: "7d · Argon", usedPercent: 0, resetsAt: "2026-11-30T09:23:21.000Z" },
    ]);
  });

  it.each([
    [-0.12, 100],
    [0, 100],
    [0.0004, 100],
    [0.25, 75],
    [0.99999, 0],
    [1, 0],
    [1.05, 0],
  ])("reports remaining %s as %s%% used, clamped to 0..100", (remainingFraction, usedPercent) => {
    const [window] = toQuotaWindows({ groups: [{ name: "G", buckets: [bucket({ remainingFraction })] }] });
    expect(window!.usedPercent).toBe(usedPercent);
    expect(Object.is(window!.usedPercent, -0)).toBe(false);
  });

  it("labels daily and unknown spans and falls back when the name is blank", () => {
    const windows = toQuotaWindows({
      groups: [
        {
          name: "Flash  models",
          buckets: [
            bucket({ bucketId: "d", window: "daily" }),
            bucket({ bucketId: "o", window: "other", name: "  Monthly   Burst " }),
            bucket({ bucketId: "e", window: "other", name: "  " }),
          ],
        },
      ],
    });
    expect(windows.map((window) => window.label)).toEqual([
      "1d · Flash",
      "Monthly Burst · Flash",
      "Limit · Flash",
    ]);
  });

  it("disambiguates colliding labels and ids deterministically", () => {
    const quota: ProviderQuota = {
      groups: [
        { name: "Gemini Models", buckets: [bucket({ bucketId: "w" }), bucket({ bucketId: "w" })] },
        { name: "Gemini model", buckets: [bucket({ bucketId: "w" })] },
      ],
    };
    const windows = toQuotaWindows(quota);
    expect(windows.map(({ id, label }) => ({ id, label }))).toEqual([
      { id: "w", label: "7d · Gemini" },
      { id: "w-2", label: "7d · Gemini (2)" },
      { id: "w-3", label: "7d · Gemini (3)" },
    ]);
    expect(toQuotaWindows(quota)).toEqual(windows);
  });
});

describe("assertUniqueWindows", () => {
  const window = (id: string, label: string): QuotaWindow => ({ id, kind: "custom", label, usedPercent: 0, resetsAt: null });

  it("accepts unique windows and rejects duplicate ids or labels", () => {
    expect(() => assertUniqueWindows([window("a", "A"), window("b", "B")])).not.toThrow();
    expect(() => assertUniqueWindows([window("a", "A"), window("a", "B")])).toThrow();
    expect(() => assertUniqueWindows([window("a", "A"), window("b", "A")])).toThrow();
  });
});
