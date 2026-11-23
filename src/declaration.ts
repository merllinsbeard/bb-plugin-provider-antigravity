import { fileURLToPath } from "node:url";
import type { PluginProviderDeclaration } from "@get-bb/plugin-sdk";
import { ANTIGRAVITY } from "./identity.ts";

export const AGY_POOL_LAUNCHER = fileURLToPath(new URL("../bin/agy-pool", import.meta.url));

const REASONING_LEVELS = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra High" },
  { id: "max", label: "Max" },
] as const;

export function antigravityDeclaration(): PluginProviderDeclaration {
  return {
    id: ANTIGRAVITY.providerId,
    displayName: ANTIGRAVITY.displayName,
    family: "antigravity",
    icon: "./icons/antigravity.svg",
    maintenance: { health: true, usage: true, installation: false },
    experimental_bridgeOptions: {
      acpDialect: ANTIGRAVITY.dialectId,
      acpLaunchSpec: {
        displayName: ANTIGRAVITY.displayName,
        command: AGY_POOL_LAUNCHER,
        args: ["acp"],
        env: {},
        permissionCli: { full: ["--dangerously-skip-permissions"], insertAfterArgs: 1 },
      },
    },
    env: { passthrough: ["BB_ANTIGRAVITY_EXECUTABLE"] },
    models: { fallback: [], scope: "host" },
    capabilities: {
      supportsServiceTier: false,
      supportsNativeUserQuestion: false,
      fork: "none",
      supportsManualCompaction: false,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      permissionModes: ["accept-edits", "full"],
      reasoningLevels: REASONING_LEVELS.map((level) => level.id),
    },
    reasoningLevels: REASONING_LEVELS,
    composerActions: [],
    experimental_nativeSkillRoots: {
      user: [{ path: ".agents/skills" }, { path: ".gemini/antigravity/skills" }, { path: ".gemini/skills" }],
      project: [
        { path: ".agents/skills", ancestors: true },
        { path: ".gemini/skills", ancestors: true },
      ],
    },
    strings: {
      signInHint: "Sign in to Google Antigravity on this machine with `agy acp --login`, then reload.",
      expiredHint: "Your Google Antigravity sign-in expired. Run `agy acp --login` on this machine, then reload.",
      installUrl: "https://antigravity.google/docs/install?tab=cli",
    },
  };
}
