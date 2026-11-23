import os from "node:os";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { experimental_registerAcpDialect } from "@get-bb/plugin-sdk/provider-bridge/acp";
import { ANTIGRAVITY } from "./src/identity.ts";
import { listAccounts, poolPaths } from "./src/pool/account.ts";
import { probeAccount } from "./src/pool/probe-account.ts";
import { listAccountsMethod, poolHostContract, readAccountUsageMethod } from "./src/pool-host-contract.ts";
import { accountUsage } from "./src/usage/account-usage.ts";
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

export default experimental_defineHostEntry({
  contract: poolHostContract,
  handlers: {
    [listAccountsMethod]: () => ({ accounts: listAccounts(paths()).map((account) => account.name) }),
    [readAccountUsageMethod]: async ({ account: name }) => {
      const account = listAccounts(paths()).find((candidate) => candidate.name === name);
      if (!account) return { found: false as const };
      return { found: true as const, usage: accountUsage(account, await probeAccount(paths(), account, locateBinary)) };
    },
  },
});

export { experimental_acpProviderBridge as experimental_providerBridge } from "@get-bb/plugin-sdk/provider-bridge/acp";
