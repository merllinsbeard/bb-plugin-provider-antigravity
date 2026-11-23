import os from "node:os";
import { experimental_registerAcpDialect } from "@get-bb/plugin-sdk/provider-bridge/acp";
import { ANTIGRAVITY } from "./src/identity.ts";
import { antigravityMaintenance } from "./src/usage/dialect.ts";
import { createPrintRunner, hasAuthToken, resolveAgyBinary } from "./src/usage/probe.ts";

experimental_registerAcpDialect({
  id: ANTIGRAVITY.dialectId,
  maintenance: antigravityMaintenance({
    locateBinary: () => resolveAgyBinary(process.env, os.homedir()),
    hasAuthToken: () => hasAuthToken(os.homedir()),
    runPrint: createPrintRunner(),
  }),
});

export { experimental_acpProviderBridge as experimental_providerBridge } from "@get-bb/plugin-sdk/provider-bridge/acp";
