import { readDirectQuota } from "../usage/direct-api.ts";
import { createPrintRunner, probeQuota } from "../usage/probe.ts";
import type { ProbeOutcome } from "../usage/types.ts";
import { accountCommand, isAuthenticated, isUsable, type Account, type PoolPaths } from "./account.ts";

export function probeAccount(
  paths: PoolPaths,
  account: Account,
  locateBinary: () => string | null,
): Promise<ProbeOutcome> {
  if (!isUsable(account))
    return Promise.resolve({ ok: false, failure: { status: "error", message: `agy-pool: ${account.egress.problem}` } });
  return probeQuota({
    locateBinary,
    hasAuthToken: () => isAuthenticated(account),
    readDirect: () => readDirectQuota({ accountDir: account.dir, route: account.egress }),
    runPrint: createPrintRunner({ command: (binary, args) => accountCommand(paths, account, binary, args) }),
  });
}
