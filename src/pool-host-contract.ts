import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { usageSchema } from "./usage-contract.ts";

export const listAccountsMethod = "antigravity-pool.v1.listAccounts";
export const readAccountUsageMethod = "antigravity-pool.v1.readAccountUsage";
export const readPoolMethod = "antigravity-pool.v1.readPool";

const windowViewSchema = z.object({ usedPercent: z.number(), resetsAt: z.string().nullable() }).nullable();

export const poolViewSchema = z.object({
  next: z.string().nullable(),
  accounts: z.array(
    z.object({
      name: z.string().min(1),
      email: z.string().nullable(),
      route: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("direct") }),
        z.object({ kind: z.literal("proxy"), endpoint: z.string() }),
        z.object({ kind: z.literal("invalid"), problem: z.string() }),
      ]),
      liveThreads: z.number().int().nonnegative(),
      boundThreads: z.number().int().nonnegative(),
      quota: z.discriminatedUnion("status", [
        z.object({
          status: z.literal("ok"),
          groups: z.array(z.object({ name: z.string(), fiveHour: windowViewSchema, weekly: windowViewSchema })),
        }),
        z.object({ status: z.literal("signed-out") }),
        z.object({ status: z.literal("expired") }),
        z.object({ status: z.literal("not-installed") }),
        z.object({ status: z.literal("error"), message: z.string() }),
      ]),
    }),
  ),
});

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
  [readPoolMethod]: {
    input: z.object({}).strict(),
    output: poolViewSchema,
    experimental_retryable: true,
    experimental_description: "Every pool account with its route, threads and quota, and the account the next thread would take.",
  },
});
