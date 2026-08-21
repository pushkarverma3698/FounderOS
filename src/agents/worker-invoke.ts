/**
 * FounderOS — one-shot worker calls, with the fallback chain attached
 * ===================================================================
 * `withModelFallbacks` (src/gateway/model-fallback.ts) makes the KERNEL honour
 * `AGENT_FALLBACK_MODELS`. Everything else that wants a single text completion —
 * `tailorCv`, `buildCoverLetter` — reached for `getWorkerModel()` and called
 * `.invoke` on it directly. That is the bare primary, and the chain never ran.
 *
 * MEASURED ON PROD, 2026-08-21, minutes after the apply packet shipped: three
 * consecutive tailoring attempts died on `gemini-flash-latest` 503, while
 * `gemini-3.1-flash-lite` and `gemini-3-flash-preview` each answered "ok" on the
 * same key in the same second. Two working models sat one line of code away from
 * an application that could not be written.
 *
 * It is the 2026-07-11 incident recurring one layer down — fallbacks armed,
 * chain never engaged, founder gets the error.
 *
 * WHY NOT REUSE gateway/model-fallback.ts: R1 (`verify-architecture.ts`) forbids
 * anything outside `src/gateway` from importing it, and that rule is right — that
 * module wraps the kernel's `bindTools` surface under a wall-clock budget, which
 * a one-shot text call does not have and does not need. This is the small half
 * of the same idea, living where `src/tools` and `src/agents` can both reach it.
 *
 * ENGAGEMENT RULE IS SHARED, deliberately: `isModelFallbackError` decides here
 * exactly as it decides in the kernel. 5xx/429/transport/404-retired fall
 * through; 401/403 fail LOUD, because the chain shares the primary's key and a
 * silent fallback would hide a dead key behind a slower success.
 */

import { childLogger } from "../infra/logger.js";
import { buildFallbackModels, getWorkerModel, isModelFallbackError } from "./model.js";

const log = childLogger({ module: "agents:worker-invoke" });

/** One turn, in the tuple form LangChain accepts. */
export interface WorkerTurn {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

/** The narrow slice of a chat model a one-shot completion needs. */
export interface InvokableModel {
  invoke(messages: unknown): Promise<{ content: unknown }>;
}

/**
 * Hard deadline per attempt.
 *
 * A provider that HANGS is not a provider that errors, and only the second kind
 * reaches a catch block. Prod 2026-08-21: a live `tailor_cv` run sat inside
 * `model.invoke` for a full 280 seconds and never reached the chain at all,
 * while two healthy fallbacks waited behind it. Matches
 * `FALLBACK_ATTEMPT_TIMEOUT_MS` in gateway/model-fallback.ts, which exists for
 * exactly this reason one layer up.
 */
export const ATTEMPT_TIMEOUT_MS = 45_000;

export interface InvokeOptions {
  /** Overridable so tests do not wait 45 real seconds to prove a timeout. */
  readonly attemptTimeoutMs?: number;
}

/** Resolve, or reject once the deadline passes. Timer always cleared. */
async function withDeadline(
  attempt: Promise<{ content: unknown }>,
  ms: number,
  label: string,
): Promise<{ content: unknown }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      attempt,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Invoke the worker model, walking `AGENT_FALLBACK_MODELS` on a retriable error.
 *
 * Throws the PRIMARY's error when the whole chain is down, never the last
 * fallback's. On 2026-08-21 the tail of the chain was two retired free
 * OpenRouter slugs answering "this model is unavailable for free" — an error
 * that sends the reader to the wrong provider entirely, while the real cause was
 * a Gemini 503.
 */
export async function invokeWorkerWithFallbacks(
  messages: readonly WorkerTurn[],
  opts: InvokeOptions = {},
): Promise<{ content: unknown }> {
  const payload = messages.map((m) => [m.role, m.content] as const);
  const timeoutMs = opts.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS;
  const primary = getWorkerModel() as unknown as InvokableModel;

  let primaryError: unknown;
  try {
    return await withDeadline(primary.invoke(payload), timeoutMs, "primary model");
  } catch (err) {
    // An auth failure is not load. Falling through would spend the chain hiding
    // a misconfiguration that only gets more expensive the longer it is hidden.
    // A TIMEOUT always falls through: a provider that never answers is exactly
    // the case the chain exists for, and `isModelFallbackError` cannot see it
    // because there is no status code on a promise that simply never settles.
    if (!isTimeout(err) && !isModelFallbackError(err)) throw err;
    primaryError = err;
  }

  const fallbacks = buildFallbackModels() as unknown as InvokableModel[];
  for (const [i, model] of fallbacks.entries()) {
    try {
      const result = await withDeadline(model.invoke(payload), timeoutMs, `fallback ${i + 1}`);
      log.warn(
        { position: i + 1, of: fallbacks.length, cause: (primaryError as Error).message.slice(0, 160) },
        "Worker primary failed — a fallback model answered",
      );
      return result;
    } catch (err) {
      log.warn(
        { position: i + 1, err: (err as Error).message.slice(0, 160) },
        "Worker fallback model failed — trying the next",
      );
    }
  }

  throw primaryError;
}

/** A deadline rejection, which carries no HTTP status for `isModelFallbackError` to read. */
function isTimeout(err: unknown): boolean {
  return err instanceof Error && err.message.includes("timed out after");
}
