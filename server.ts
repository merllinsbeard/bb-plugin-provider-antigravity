import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { antigravityDeclaration } from "./src/declaration.ts";
import { registerQuotaHandoff } from "./src/quota-handoff.ts";
import { registerQuotaRetry } from "./src/quota-retry.ts";
import { registerUsageSource } from "./src/usage-source.ts";

export default function plugin(bb: BbPluginApi) {
  bb.providers.register(antigravityDeclaration());
  registerUsageSource(bb);
  registerQuotaRetry(bb, registerQuotaHandoff(bb));
}
