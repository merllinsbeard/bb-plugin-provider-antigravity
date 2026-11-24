import { describe, expect, it } from "vitest";
import { presentDefaultModel } from "../src/default-model.ts";

const model = (id: string, isDefault: boolean, levels: string[]) => ({
  id,
  model: id,
  displayName: id,
  description: "",
  isDefault,
  defaultReasoningEffort: "high",
  reasoningDiscovery: "known" as const,
  supportedReasoningEfforts: levels.map((reasoningEffort) => ({ reasoningEffort, description: "" })),
});

describe("default model", () => {
  it("starts new threads on Claude Opus 5.5 at medium instead of agy's pick", () => {
    const catalog = [model("gemini-4-neon", true, ["low", "medium", "high", "xhigh"]), model("claude-opus-5-5", false, ["low", "medium", "high"])];
    const shown = catalog.map(presentDefaultModel);
    expect(shown.filter((m) => m.isDefault).map((m) => [m.id, m.defaultReasoningEffort])).toEqual([["claude-opus-5-5", "medium"]]);
  });
});
