import os from "node:os";
import { experimental_registerAcpDialect } from "@get-bb/plugin-sdk/provider-bridge/acp";
import { ANTIGRAVITY } from "./src/identity.ts";
import { listAccounts, poolPaths } from "./src/pool/account.ts";
import { probeAccount } from "./src/pool/probe-account.ts";
import { antigravityMaintenance } from "./src/usage/dialect.ts";
import { resolveAgyBinary } from "./src/usage/probe.ts";

const locateBinary = () => resolveAgyBinary(process.env, os.homedir());
const paths = () => poolPaths(process.env, os.homedir());

experimental_registerAcpDialect({
  id: ANTIGRAVITY.dialectId,
  maintenance: antigravityMaintenance({
    locateBinary,
    accounts: () => listAccounts(paths()),
    probe: (account) => probeAccount(paths(), account, locateBinary),
  }),
});

export { experimental_acpProviderBridge as experimental_providerBridge } from "@get-bb/plugin-sdk/provider-bridge/acp";
