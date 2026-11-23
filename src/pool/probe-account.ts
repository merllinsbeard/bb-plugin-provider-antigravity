import { createPrintRunner, probeQuota } from "../usage/probe.ts";
import type { ProbeOutcome } from "../usage/types.ts";
import { accountCommand, isAuthenticated, type Account, type PoolPaths } from "./account.ts";

export function probeAccount(
  paths: PoolPaths,
  account: Account,
  locateBinary: () => string | null,
): Promise<ProbeOutcome> {
  return probeQuota({
    locateBinary,
    hasAuthToken: () => isAuthenticated(account),
    runPrint: createPrintRunner({ command: (binary, args) => accountCommand(paths, account, binary, args) }),
  });
}
