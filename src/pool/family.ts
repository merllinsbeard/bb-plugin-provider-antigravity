// agy meters models in groups ("Gemini Models", "Claude and GPT models"),
// and each group has its own 5-hour and weekly windows. An account that ran
// out of one group can still serve every model of the other.
export type ModelFamily = "gemini" | "3p";

const LABELS: Record<ModelFamily, string> = { gemini: "Gemini", "3p": "Claude/GPT" };

export function modelFamily(modelId: string): ModelFamily {
  return /^(claude|gpt)-/i.test(modelId) ? "3p" : "gemini";
}

export function parseModelFamily(raw: string): ModelFamily | null {
  return raw === "gemini" || raw === "3p" ? raw : null;
}

export function familyLabel(family: ModelFamily): string {
  return LABELS[family];
}

/** agy names a group's buckets `<family>-5h` and `<family>-weekly`. */
export function bucketFamily(bucketId: string): string {
  return bucketId.replace(/-(5h|weekly)$/, "");
}
