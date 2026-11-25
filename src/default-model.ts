import type { AcpDialect } from "@get-bb/plugin-sdk/provider-bridge/acp";

type AvailableModel = Parameters<NonNullable<AcpDialect["presentModel"]>>[0];

/** The model and reasoning level a new Antigravity thread starts with, in place of agy's own pick. */
export const DEFAULT_MODEL = { id: "claude-opus-5-5", reasoning: "medium" } as const;

export function presentDefaultModel(model: AvailableModel): AvailableModel {
  if (model.model !== DEFAULT_MODEL.id && model.id !== DEFAULT_MODEL.id) return { ...model, isDefault: false };
  const supportsLevel = model.supportedReasoningEfforts.some((level) => level.reasoningEffort === DEFAULT_MODEL.reasoning);
  return {
    ...model,
    isDefault: true,
    defaultReasoningEffort: supportsLevel ? DEFAULT_MODEL.reasoning : model.defaultReasoningEffort,
  };
}
