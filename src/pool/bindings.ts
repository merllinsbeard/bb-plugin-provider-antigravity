import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { parseAccountName, type AccountName } from "./account.ts";

export type ThreadBinding = {
  readonly account: AccountName;
  readonly pid: number | null;
  readonly boundAt: string;
};

export type Bindings = ReadonlyMap<string, ThreadBinding>;

const fileSchema = z.object({
  version: z.literal(1),
  threads: z.record(
    z.string(),
    z.object({
      account: z.string().transform((raw, ctx) => parseAccountName(raw) ?? (ctx.addIssue("bad account name"), z.NEVER)),
      pid: z.number().int().positive().nullable(),
      boundAt: z.string(),
    }),
  ),
});

export function readBindings(file: string): Bindings {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw error;
  }
  const parsed = fileSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error(`${file} is not a valid agy-pool bindings file.`);
  return new Map(Object.entries(parsed.data.threads));
}

export function writeBindings(file: string, bindings: Bindings): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ version: 1, threads: Object.fromEntries(bindings) }, null, 2)}\n`);
  renameSync(temp, file);
}

function isLauncherOf(threadId: string, pid: number): boolean {
  try {
    return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(`BB_THREAD_ID=${threadId}`);
  } catch {
    return false;
  }
}

export function liveThreadCounts(bindings: Bindings, isAlive = isLauncherOf): Map<AccountName, number> {
  const counts = new Map<AccountName, number>();
  for (const [threadId, binding] of bindings)
    if (binding.pid !== null && isAlive(threadId, binding.pid))
      counts.set(binding.account, (counts.get(binding.account) ?? 0) + 1);
  return counts;
}
