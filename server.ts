import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { antigravityDeclaration } from "./src/declaration.ts";
import { registerPoolPanel } from "./src/pool-panel.ts";
import { registerUsageSource } from "./src/usage-source.ts";

export default function plugin(bb: BbPluginApi) {
  bb.providers.register(antigravityDeclaration());
  registerUsageSource(bb);
  registerPoolPanel(bb);
}
