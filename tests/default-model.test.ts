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
  it("starts new threads on Gemini 4 Neon at high instead of agy's pick", () => {
    const catalog = [model("gemini-4-neon", false, ["low", "medium", "high"]), model("claude-opus-5-5", true, ["low", "medium", "high"])];
    const shown = catalog.map(presentDefaultModel);
    expect(shown.filter((m) => m.isDefault).map((m) => [m.id, m.defaultReasoningEffort])).toEqual([["gemini-4-neon", "high"]]);
  });
});
