export const ANTIGRAVITY = {
  pluginId: "provider-antigravity",
  providerId: "antigravity",
  dialectId: "antigravity",
  displayName: "Google Antigravity",
} as const;

export function isAntigravity(provider: { id: string; pluginId?: string | null }): boolean {
  return provider.pluginId === ANTIGRAVITY.pluginId && provider.id === ANTIGRAVITY.providerId;
}

export const AGY_STATE_DIR = ".gemini/antigravity-cli";
export const AGY_TOKEN_FILE = "antigravity-oauth-token";
