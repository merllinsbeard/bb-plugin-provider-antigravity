import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { poolViewSchema } from "./pool-host-contract.ts";

export const readPanelMethod = "pool-panel.v1.read";

export const machinePoolSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  observedAt: z.number().int().nonnegative().nullable(),
  pool: poolViewSchema.nullable(),
  error: z.string().nullable(),
});

export const poolPanelContract = defineRpcContract({
  [readPanelMethod]: {
    input: z.object({ refresh: z.boolean() }).strict(),
    output: z.object({ machines: z.array(machinePoolSchema) }),
    experimental_description: "The Antigravity pool on every connected machine: accounts, routes, threads, quota and the next pick.",
  },
});

export type MachinePool = z.infer<typeof machinePoolSchema>;
