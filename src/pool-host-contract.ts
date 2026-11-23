import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { usageSchema } from "./usage-contract.ts";

export const listAccountsMethod = "antigravity-pool.v1.listAccounts";
export const readAccountUsageMethod = "antigravity-pool.v1.readAccountUsage";

export const poolHostContract = defineRpcContract({
  [listAccountsMethod]: {
    input: z.object({}).strict(),
    output: z.object({ accounts: z.array(z.string().min(1)) }),
    experimental_retryable: true,
    experimental_description: "Names of the pool's accounts on this machine in display order. Reads folders only.",
  },
  [readAccountUsageMethod]: {
    input: z.object({ account: z.string().min(1) }).strict(),
    output: z.discriminatedUnion("found", [
      z.object({ found: z.literal(false) }),
      z.object({ found: z.literal(true), usage: usageSchema }),
    ]),
    experimental_retryable: true,
    experimental_description: "Live quota of exactly one pool account, measured through that account's own route.",
  },
});
