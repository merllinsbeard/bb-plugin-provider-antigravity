// When the whole Antigravity pool is out of quota, a thread the owner works in
// directly continues on another provider the way bb's own "Hand off to new
// thread" does: a new thread in the same environment whose prompt starts with
// `Continue from @thread:<id>`. Child threads stay out: their parent agent gets
// the failure and applies its own fallback, and two actors relaunching the same
// work is what this must not cause. Plugin-spawned threads stay out because the
// plugin that started them owns their retries.
import type { BbPluginApi, PluginThreadEventPayloads } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { ANTIGRAVITY } from "./identity.ts";

type ThreadResponse = PluginThreadEventPayloads["thread.failed"]["thread"];

/** The pool's words when no account has room for a family (`src/pool/launcher.ts`), as the relay fails the turn with them. */
const POOL_EXHAUSTED = /agy-pool: every Antigravity account is out of (?:(\S.*?) )?quota\.(?: The nearest reset is (\S+) \(account "[^"]*"\)\.)?/;

export type PoolExhaustion = {
  /** The model family label ("Claude/GPT", "Gemini"), or null when the pool did not know the session's model. */
  readonly family: string | null;
  /** ISO time of the nearest reset, when the pool knew one. */
  readonly resetsAt: string | null;
};

export function parsePoolExhaustion(text: string): PoolExhaustion | null {
  const match = POOL_EXHAUSTED.exec(text);
  return match === null ? null : { family: match[1] ?? null, resetsAt: match[2] ?? null };
}

/** A thread the owner works in directly: visible, top level, not started by a plugin. */
export function isOwnerThread(thread: Pick<ThreadResponse, "providerId" | "parentThreadId" | "visibility" | "originPluginId">): boolean {
  return (
    thread.providerId === ANTIGRAVITY.providerId &&
    thread.parentThreadId === null &&
    thread.visibility === "visible" &&
    thread.originPluginId === null
  );
}

/** The plugin-metadata key on the failed thread: which failure was handed off, and to which thread. */
const RECORD_KEY = "quotaHandoff";

type HandoffRecord = { readonly failureEventId: string; readonly successorThreadId: string | null };

function readRecord(metadata: Record<string, unknown>): HandoffRecord | null {
  const value = metadata[RECORD_KEY];
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const { failureEventId, successorThreadId } = value as Record<string, unknown>;
  return typeof failureEventId === "string"
    ? { failureEventId, successorThreadId: typeof successorThreadId === "string" ? successorThreadId : null }
    : null;
}

function continuationInput(thread: ThreadResponse, exhaustion: PoolExhaustion) {
  const mention = `@thread:${thread.id}`;
  const lead = "Continue from ";
  const quota = exhaustion.family === null ? "quota" : `${exhaustion.family} quota`;
  const reset = exhaustion.resetsAt === null ? "" : ` until ${exhaustion.resetsAt}`;
  const text =
    `${lead}${mention}\n\n` +
    `That thread stopped because every Antigravity account is out of ${quota}${reset}; ` +
    "finish its last task here without redoing work it already finished.";
  const label = thread.title ?? thread.titleFallback ?? thread.id;
  return [
    {
      type: "text" as const,
      text,
      mentions: [
        {
          start: lead.length,
          end: lead.length + mention.length,
          resource: { kind: "thread" as const, projectId: thread.projectId, threadId: thread.id, label },
        },
      ],
    },
  ];
}

/**
 * bb's own error notification opens the failed thread, which shows only the pool's error. On 25.11 the owner read it
 * there and started the same task by hand next to the running successor, so a second notification opens the successor.
 */
async function announce(bb: BbPluginApi, thread: ThreadResponse, exhaustion: PoolExhaustion, successorId: string): Promise<void> {
  const quota = exhaustion.family === null ? "quota" : `${exhaustion.family} quota`;
  const reset = exhaustion.resetsAt === null ? "" : ` until ${exhaustion.resetsAt.slice(0, 10)} ${exhaustion.resetsAt.slice(11, 16)} UTC`;
  try {
    const { channels } = await bb.sdk.plugins.callRpc({
      pluginId: "push-notifications",
      method: "notifications.send",
      input: {
        // bb cuts the title at 80 characters, so the prefix stays short.
        title: `Continues: ${thread.title ?? thread.titleFallback ?? thread.id}`,
        body: `Every Antigravity account is out of ${quota}${reset}. The task goes on in a new thread; open it from here.`,
        threadId: successorId,
      },
      outputSchema: z.object({ ok: z.literal(true), channels: z.array(z.string()) }),
    });
    if (channels.length === 0) bb.log.warn(`No notification channel took the hand-off notice of ${thread.id} to ${successorId}.`);
  } catch (error) {
    // The successor already runs; a missing notification channel must not undo or repeat the hand-off.
    bb.log.warn(`Could not announce the hand-off of ${thread.id} to ${successorId}: ${(error as Error).message}`);
  }
}

export function registerQuotaHandoff(bb: BbPluginApi): void {
  const settings = bb.settings.define({
    quotaHandoff: {
      type: "boolean",
      label: "Hand off when the pool is out of quota",
      description:
        "When every Antigravity account is out of quota, a visible top-level thread continues in a new thread on the provider below.",
      default: true,
    },
    quotaHandoffProvider: { type: "string", label: "Hand-off provider", default: "claude-code" },
    quotaHandoffModel: { type: "string", label: "Hand-off model", default: "claude-opus-5-5" },
    quotaHandoffReasoning: { type: "string", label: "Hand-off reasoning level", default: "medium" },
  });
  // A thread whose failure is being handed off right now; metadata guards across reloads, this guards one process.
  const inFlight = new Set<string>();

  bb.events.on("thread.failed", async ({ thread }) => {
    if (!isOwnerThread(thread) || inFlight.has(thread.id)) return;
    inFlight.add(thread.id);
    try {
      const config = await settings.get();
      if (!config.quotaHandoff) return;
      // The newest of these is what failed this turn: a prompt error is provider/error (agy-pool's text in `detail`), a
      // start-up error is system/error. A turn request on top means this turn left no error, so an older one cannot count.
      const [failure] = await bb.sdk.threads.events.list({
        threadId: thread.id,
        order: "desc",
        limit: "1",
        types: ["provider/error", "system/error", "client/turn/requested"],
      });
      if (failure === undefined || failure.type === "client/turn/requested") return;
      const data = failure.data as { message?: unknown; detail?: unknown };
      const exhaustion = parsePoolExhaustion([data.message, data.detail].filter((part) => typeof part === "string").join("\n"));
      if (exhaustion === null) return;
      const metadata = await bb.sdk.threads.getPluginMetadata({ threadId: thread.id });
      if (readRecord(metadata)?.failureEventId === failure.id) return;
      // Claim the failure before spawning: a crash between the two loses one hand-off rather than doubling it.
      await bb.sdk.threads.updatePluginMetadata({
        threadId: thread.id,
        set: { [RECORD_KEY]: { failureEventId: failure.id, successorThreadId: null } },
      });
      const execution = await bb.sdk.threads.defaultExecutionOptions({ threadId: thread.id });
      const successor = await bb.sdk.threads.spawn({
        projectId: thread.projectId,
        environment: thread.environmentId === null ? { type: "project-default" } : { type: "reuse", environmentId: thread.environmentId },
        providerId: config.quotaHandoffProvider,
        model: config.quotaHandoffModel,
        reasoningLevel: config.quotaHandoffReasoning,
        ...(execution === null ? {} : { permissionMode: execution.permissionMode }),
        executionInputSources: {
          providerId: "explicit",
          model: "explicit",
          reasoningLevel: "explicit",
          ...(execution === null ? {} : { permissionMode: "explicit" as const }),
        },
        input: continuationInput(thread, exhaustion),
        // The owner finds the task by its name in the sidebar; a generated "Continue interrupted task" hid it on 25.11.
        ...(thread.title === null ? {} : { title: thread.title }),
        visibility: "visible",
      });
      await bb.sdk.threads.updatePluginMetadata({
        threadId: thread.id,
        set: { [RECORD_KEY]: { failureEventId: failure.id, successorThreadId: successor.id } },
      });
      bb.log.info(`Thread ${thread.id} ran out of Antigravity quota; continued in ${successor.id}.`);
      await announce(bb, thread, exhaustion, successor.id);
    } finally {
      inFlight.delete(thread.id);
    }
  });
}
