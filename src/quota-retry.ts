// bb's own provider-retry plugin reschedules failed turns from the failure's structured `errorInfo`, which bb's ACP bridge
// never fills in, so it skips every Antigravity failure as "not-retryable". On 26.11 that left 19-29% of child and
// workflow threads failed on a 5h quota pause or a transient Google error. This listener reads the failure text the pool
// and agy leave instead and queues the same durable retry provider-retry would (`bb.sdk.threads.retry`): bb keeps the row
// across restarts, the Workflows plugin keeps waiting on a worker that has one, and core refuses a second row for the same
// turn. The owner's 25.11 decision still holds: a visible top-level thread whose whole pool is out hands off to another
// provider at once (`quota-handoff.ts`), so a pool exhaustion there is left to the hand-off.
import type { BbPluginApi, PluginThreadEventPayloads, PluginTurnFailedEvent } from "@get-bb/plugin-sdk";
import { ANTIGRAVITY } from "./identity.ts";
import { isOwnerThread, parsePoolExhaustion, type PoolExhaustion } from "./quota-handoff.ts";

type Thread = PluginThreadEventPayloads["thread.failed"]["thread"];
type ErrorInfo = PluginTurnFailedEvent["errorInfo"];

export type Failure =
  | { readonly kind: "pool-exhausted"; readonly exhaustion: PoolExhaustion }
  /** `label` names the cause on the queued row. */
  | { readonly kind: "transient"; readonly label: string }
  | { readonly kind: "non-retryable" };

export type DeclineReason =
  | "not-antigravity"
  | "native-provider-retry"
  | "attempts-exhausted"
  | "delegated-to-handoff"
  | "quota-retry-disabled"
  | "reset-unknown"
  | "beyond-maximum-wait"
  | "not-retryable";

export type RetryDecision =
  | { readonly kind: "retry"; readonly sendAt: number; readonly reason: string }
  | { readonly kind: "decline"; readonly reason: DeclineReason };

/** A refusal retrying cannot fix: sign-in, region, plan, a missing agy, a broken proxy file or an unknown model. */
const PERMANENT =
  /\b40[13]\b|unauthori[sz]ed|unauthenticated|forbidden|permission[ _]denied|UNSUPPORTED_LOCATION|SUBSCRIPTION_REQUIRED|not_installed|invalid proxy|is unusable|sign[- ]?in|log ?in\b|expired|unknown model/i;

/** Failures that clear by themselves, first match wins. agy's and the relay's words, Google's HTTP and gRPC codes, Node's socket errors. */
const TRANSIENT: readonly (readonly [RegExp, string])[] = [
  [/agy exited during account swap/i, "agy restarted during an account swap"],
  [/could not move to another account/i, "account failover did not finish"],
  [/no capacity|overloaded|\bUNAVAILABLE\b|service unavailable|\b(?:http|status|code|error)\W{0,3}503\b|\b503\b/i, "Google is out of capacity"],
  [/\b(?:http|status|code|error)\W{0,3}50[024]\b|\b50[024] (?:internal|bad gateway|gateway timeout)|internal server error|bad gateway|gateway timeout|DEADLINE_EXCEEDED/i, "Google server error"],
  [/\bE(?:CONNRESET|CONNREFUSED|TIMEDOUT|HOSTUNREACH|NETUNREACH|AI_AGAIN|PIPE)\b|socket hang up|connection (?:reset|closed|refused|failed)|stream disconnected|network error|fetch failed/i, "connection dropped"],
  [/RESOURCE_EXHAUSTED|quota reached/i, "short quota throttle"],
];

export function classifyFailure(text: string): Failure {
  const exhaustion = parsePoolExhaustion(text);
  if (exhaustion !== null) return { kind: "pool-exhausted", exhaustion };
  if (PERMANENT.test(text)) return { kind: "non-retryable" };
  const match = TRANSIENT.find(([pattern]) => pattern.test(text));
  return match === undefined ? { kind: "non-retryable" } : { kind: "transient", label: match[1] };
}

/**
 * The failures bb's provider-retry already reschedules from `errorInfo` (overload, rate limit, 5xx, dropped
 * connection). bb's ACP bridge sends none of these today; should it start, provider-retry keeps them and this stands down.
 */
function nativeRetryOwns(errorInfo: ErrorInfo): boolean {
  if (errorInfo === null) return false;
  const { category, httpStatusCode } = errorInfo;
  return (
    ["overloaded", "rate-limit", "connection-failed", "internal", "stream-disconnected"].includes(category) ||
    (httpStatusCode !== null && [429, 500, 502, 503, 504].includes(httpStatusCode))
  );
}

/** Attempt 5 is the fourth retry, the cap provider-retry uses too. */
const MAX_ATTEMPT = 5;
/** 15-30 s after the first failure, doubling: the fourth retry waits 2-4 minutes. */
const BACKOFF_BASE_MS = 15_000;

export type RetryInput = {
  readonly thread: Pick<Thread, "providerId" | "parentThreadId" | "visibility" | "originPluginId">;
  readonly failure: Failure;
  readonly errorInfo: ErrorInfo;
  /** Which attempt just failed: 1 is the original turn. */
  readonly attemptNumber: number;
  readonly quotaHandoffEnabled: boolean;
  /** A pool exhaustion whose reset is farther away fails at once, so the parent can fall back instead of waiting. */
  readonly maxQuotaWaitMs: number;
  readonly nowMs: number;
  /** In [0, 1): spreads threads that failed together so they do not return together. */
  readonly random: number;
};

export function decideAntigravityRetry(input: RetryInput): RetryDecision {
  const { thread, failure, attemptNumber, nowMs, random } = input;
  if (thread.providerId !== ANTIGRAVITY.providerId) return { kind: "decline", reason: "not-antigravity" };
  if (nativeRetryOwns(input.errorInfo)) return { kind: "decline", reason: "native-provider-retry" };
  if (attemptNumber >= MAX_ATTEMPT) return { kind: "decline", reason: "attempts-exhausted" };
  switch (failure.kind) {
    case "non-retryable":
      return { kind: "decline", reason: "not-retryable" };
    case "transient": {
      const step = BACKOFF_BASE_MS * 2 ** (attemptNumber - 1);
      return { kind: "retry", sendAt: nowMs + step + Math.floor(random * step), reason: `Antigravity: ${failure.label} (retry ${attemptNumber} of ${MAX_ATTEMPT - 1})` };
    }
    case "pool-exhausted": {
      if (input.quotaHandoffEnabled && isOwnerThread(thread)) return { kind: "decline", reason: "delegated-to-handoff" };
      if (input.maxQuotaWaitMs <= 0) return { kind: "decline", reason: "quota-retry-disabled" };
      const resetsAtMs = failure.exhaustion.resetsAt === null ? Number.NaN : Date.parse(failure.exhaustion.resetsAt);
      if (Number.isNaN(resetsAtMs)) return { kind: "decline", reason: "reset-unknown" };
      if (resetsAtMs - nowMs > input.maxQuotaWaitMs) return { kind: "decline", reason: "beyond-maximum-wait" };
      const quota = failure.exhaustion.family === null ? "quota" : `${failure.exhaustion.family} quota`;
      const at = new Date(resetsAtMs).toISOString().slice(11, 16);
      return {
        kind: "retry",
        sendAt: Math.max(resetsAtMs, nowMs) + 15_000 + Math.floor(random * 30_000),
        reason: `Antigravity ${quota} resets at ${at} UTC`,
      };
    }
  }
}

export function registerQuotaRetry(bb: BbPluginApi, handoff: { get(): Promise<{ quotaHandoff: boolean }> }): void {
  const settings = bb.settings.define({
    quotaRetryMaxWaitMinutes: {
      type: "number",
      label: "Wait for a quota reset up to (minutes)",
      description:
        "When every Antigravity account is out of quota, a thread that does not hand off retries after the reset if it comes within this many minutes. 0 turns quota retries off; transient errors are retried either way.",
      default: 60,
    },
  });
  // A failure being decided right now; core's refusal of a second retry row guards across processes.
  const inFlight = new Set<string>();

  bb.events.on("turn.failed", async (event) => {
    const { threadId } = event;
    if (inFlight.has(threadId)) return;
    inFlight.add(threadId);
    try {
      // One round of reads: the Workflows plugin replaces a worker as soon as provider-retry has declined the failure and
      // no retry row is queued yet, so the row has to land before Workflows looks.
      const [thread, [latest], retryConfig, handoffConfig] = await Promise.all([
        bb.sdk.threads.get({ threadId }),
        // As in quota-handoff.ts: a prompt error is provider/error, a start-up error system/error, and a turn request on
        // top means this turn left no error text.
        bb.sdk.threads.events.list({ threadId, order: "desc", limit: "1", types: ["provider/error", "system/error", "client/turn/requested"] }),
        settings.get(),
        handoff.get(),
      ]);
      const data = (latest === undefined || latest.type === "client/turn/requested" ? {} : latest.data) as { message?: unknown; detail?: unknown };
      const text = [data.message, data.detail].filter((part) => typeof part === "string").join("\n");
      const decision = decideAntigravityRetry({
        thread,
        failure: classifyFailure(text),
        errorInfo: event.errorInfo,
        attemptNumber: event.attemptNumber,
        quotaHandoffEnabled: handoffConfig.quotaHandoff,
        maxQuotaWaitMs: retryConfig.quotaRetryMaxWaitMinutes * 60_000,
        nowMs: Date.now(),
        random: Math.random(),
      });
      if (decision.kind === "decline") {
        if (decision.reason !== "not-antigravity") bb.log.info(`No Antigravity retry for ${threadId}: ${decision.reason}.`);
        return;
      }
      await bb.sdk.threads.retry({ threadId, turnRequestId: event.requestId, sendAt: decision.sendAt, reason: decision.reason });
      bb.log.info(`Antigravity retry for ${threadId} at ${new Date(decision.sendAt).toISOString()}: ${decision.reason}.`);
    } catch (error) {
      // A row already queued (here or by provider-retry), or a thread archived or answered since: nothing left to do.
      const code = (error as { code?: unknown }).code;
      if (code === "retry_already_queued") bb.log.info(`Antigravity retry for ${threadId} was already queued.`);
      else bb.log.warn(`Could not schedule an Antigravity retry for ${threadId}: ${(error as Error).message}`);
    } finally {
      inFlight.delete(threadId);
    }
  });
}
