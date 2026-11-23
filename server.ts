import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { antigravityDeclaration } from "./src/declaration.js";
import { registerUsageSource } from "./src/usage-source.js";

export default function plugin(bb: BbPluginApi) {
  bb.providers.register(antigravityDeclaration());
  registerUsageSource(bb);
}
