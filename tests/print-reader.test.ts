import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseUsageJson } from "../src/usage/print-reader.ts";

const live = readFileSync(new URL("./fixtures/usage-live.json", import.meta.url), "utf8");

function envelope(command: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ status: "SUCCESS", response: "", command, ...extra });
}

function usage(groups: unknown): string {
  return envelope({ name: "usage", data: { groups } });
}

describe("parseUsageJson", () => {
  it("reads every group and bucket of the live agy /usage output in provider order", () => {
    const result = parseUsageJson(live);
    expect(result).toEqual({
      ok: true,
      quota: {
        groups: [
          {
            name: "Gemini Models",
            buckets: [
              {
                bucketId: "gemini-weekly",
                name: "Weekly Limit Remaining",
                window: "weekly",
                remainingFraction: 0.601108968257904,
                resetsAtIso: "2026-11-28T15:54:51.000Z",
              },
              {
                bucketId: "gemini-5h",
                name: "Five Hour Limit Remaining",
                window: "5h",
                remainingFraction: 0.23720106482505798,
                resetsAtIso: "2026-11-23T11:13:01.000Z",
              },
            ],
          },
          {
            name: "Claude and GPT models",
            buckets: [
              {
                bucketId: "3p-weekly",
                name: "Weekly Limit Remaining",
                window: "weekly",
                remainingFraction: 1,
                resetsAtIso: "2026-11-30T09:23:21.000Z",
              },
              {
                bucketId: "3p-5h",
                name: "Five Hour Limit Remaining",
                window: "5h",
                remainingFraction: 1,
                resetsAtIso: "2026-11-23T14:23:21.000Z",
              },
            ],
          },
          {
            name: "Gemini 4 Argon",
            buckets: [
              {
                bucketId: "gemini-argon-wtu-weekly",
                name: "Gemini 4 Argon Weekly Limit",
                window: "weekly",
                remainingFraction: 1,
                resetsAtIso: "2026-11-30T09:23:21.000Z",
              },
            ],
          },
        ],
      },
    });
  });

  it("reports not-expanded when agy answered /usage as a prompt", () => {
    expect(parseUsageJson(JSON.stringify({ status: "SUCCESS", response: "Sure!" }))).toEqual({
      ok: false,
      failure: { kind: "not-expanded" },
    });
  });

  it("surfaces the provider message when status is not SUCCESS", () => {
    expect(parseUsageJson(JSON.stringify({ status: "ERROR", response: " quota service down \n" }))).toEqual({
      ok: false,
      failure: { kind: "provider-error", message: "quota service down" },
    });
    expect(parseUsageJson(JSON.stringify({ status: "ERROR" }))).toEqual({
      ok: false,
      failure: { kind: "provider-error", message: "agy reported status ERROR" },
    });
  });

  it.each([
    ["non-JSON stdout", "Authentication required"],
    ["empty stdout", ""],
    ["a JSON array", "[]"],
    ["another command", envelope({ name: "help", data: { groups: [] } })],
    ["no groups", usage([])],
    ["groups without data", envelope({ name: "usage" })],
    [
      "only unusable buckets",
      usage([
        {
          name: "Gemini Models",
          buckets: [
            { id: "a", window: "weekly", remaining_fraction: "0.5" },
            { id: "b", window: "5h", remaining_fraction: null },
            { id: "c", window: "5h" },
          ],
        },
      ]),
    ],
  ])("reports malformed for %s", (_, stdout) => {
    const result = parseUsageJson(stdout);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe("malformed");
  });

  it("keeps usable buckets (with or without a reset), drops disabled buckets and empty groups, and tolerates unknown fields", () => {
    const result = parseUsageJson(
      usage([
        { name: "Empty", buckets: [{ id: "x", remaining_fraction: Number.NaN }] },
        "not a group",
        {
          name: "Gemini Models",
          extra: true,
          buckets: [
            { id: "bad", remaining_fraction: "1" },
            { name: "Daily cap", window: "daily", remaining_fraction: 0.5, reset_time: "soon", future: 1 },
            { window: "monthly", remaining_fraction: 0.25, reset_time: 12 },
            { id: "3p-5h", window: "5h", disabled: true, remaining_fraction: 1 },
            { id: "no-reset", name: "No reset", window: "weekly", remaining_fraction: 0.75 },
            { id: "zero-reset", name: "Unused", window: "5h", remaining_fraction: 1, reset_time: "1970-01-01T00:00:00Z" },
          ],
        },
      ]),
    );
    expect(result).toEqual({
      ok: true,
      quota: {
        groups: [
          {
            name: "Gemini Models",
            buckets: [
              {
                bucketId: "Gemini Models:Daily cap",
                name: "Daily cap",
                window: "daily",
                remainingFraction: 0.5,
                resetsAtIso: null,
              },
              {
                bucketId: "Gemini Models:2",
                name: "",
                window: "other",
                remainingFraction: 0.25,
                resetsAtIso: null,
              },
              {
                bucketId: "no-reset",
                name: "No reset",
                window: "weekly",
                remainingFraction: 0.75,
                resetsAtIso: null,
              },
              {
                bucketId: "zero-reset",
                name: "Unused",
                window: "5h",
                remainingFraction: 1,
                resetsAtIso: null,
              },
            ],
          },
        ],
      },
    });
  });
});
