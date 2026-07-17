/**
 * FounderOS — kernel model fallback wrapper (gateway seam)
 * =========================================================
 * Wraps the kernel's structural model interface (invoke + optional bindTools)
 * so AGENT_FALLBACK_MODELS actually engages on retriable provider failures.
 *
 * WHY HERE and not LangChain's withFallbacks: RunnableWithFallbacks does not
 * expose bindTools (the v2 lesson recorded at src/agents/model.ts
 * getSupervisorModel "@deprecated" note). The kernel only needs
 * { invoke, bindTools? }, so a structural combinator preserves tool binding
 * by re-wrapping the BOUND models.
 *
 * Engagement rule = isModelFallbackError (5xx/429/408/transport/404 retired
 * model). Auth failures (401/403) fail LOUD and never burn the chain — the
 * fallback shares no key with the primary, so silence would hide a misconfig
 * (audit Run B).
 *
 * 2026-07-11 incident this closes: prod Gemini died (free-tier 429, then the
 * gemini-2.5-flash retirement 404) and every turn errored at the founder even
 * though two free OpenRouter fallbacks were configured — kernel-boot injected
 * the bare primary model, so the chain never ran.
 */

import type { KernelBindableModel, KernelChatModel, KernelTool } from "../kernel/index.js";
import { isModelFallbackError } from "../agents/model.js";
import { raceWithDeadline } from "./model-deadline.js";
import { childLogger } from "../infra/logger.js";

const log = childLogger({ module: "model-fallback" });

/** Pause before the post-chain primary retry — Gemini 503 spikes clear in seconds. */
export const PRIMARY_RETRY_DELAY_MS = 2_500;

/** Hard deadline per fallback attempt (fallbacks are bare SDK models with no retry layer of their own). */
export const FALLBACK_ATTEMPT_TIMEOUT_MS = 45_000;

/**
 * Total wall-clock budget for ONE model resolution (primary + chain + post-chain
 * retry). 2026-07-17: without this, a full-provider 503 storm summed past the
 * 300s turn watchdog on every turn — the founder got generic 5-minute hangs
 * instead of a fast, typed provider failure.
 */
export const MODEL_RESOLUTION_BUDGET_MS = 120_000;

export interface FallbackOptions {
  /** Overridable for tests; defaults to PRIMARY_RETRY_DELAY_MS. */
  primaryRetryDelayMs?: number;
  /** Hard deadline per fallback attempt. Default FALLBACK_ATTEMPT_TIMEOUT_MS. */
  attemptTimeoutMs?: number;
  /** Total budget for the whole resolution. Default MODEL_RESOLUTION_BUDGET_MS. */
  budgetMs?: number;
  /** Injectable clock for tests. Defaults to Date.now. */
  now?: () => number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Wrap a primary model with an ordered fallback chain. Returns the primary
 * untouched when the chain is empty (identity — zero overhead for tests and
 * single-model configs).
 */
export function withModelFallbacks(
  primary: KernelBindableModel,
  fallbacks: KernelBindableModel[],
  label = "kernel",
  options: FallbackOptions = {},
): KernelBindableModel {
  if (fallbacks.length === 0) return primary;
  const retryDelayMs = options.primaryRetryDelayMs ?? PRIMARY_RETRY_DELAY_MS;
  const attemptTimeoutMs = options.attemptTimeoutMs ?? FALLBACK_ATTEMPT_TIMEOUT_MS;
  const budgetMs = options.budgetMs ?? MODEL_RESOLUTION_BUDGET_MS;
  const now = options.now ?? Date.now;

  return {
    async invoke(messages) {
      const started = now();
      const remaining = (): number => budgetMs - (now() - started);
      try {
        // The primary is normally the retry-wrapped model with tighter internal
        // bounds; the budget race is the backstop for a bare hung primary.
        return await raceWithDeadline(primary.invoke(messages), budgetMs, label);
      } catch (err) {
        if (!isModelFallbackError(err)) throw err;
        log.warn(
          { label, err: err instanceof Error ? err.message : String(err) },
          "Primary model failed retriably — engaging fallback chain",
        );
        let lastErr: unknown = err;
        for (const [i, fb] of fallbacks.entries()) {
          if (remaining() <= 0) {
            log.warn(
              { label, fallbackIndex: i, budgetMs },
              "Resolution budget exhausted — skipping remaining fallbacks",
            );
            throw lastErr;
          }
          try {
            const reply = await raceWithDeadline(
              fb.invoke(messages),
              Math.min(attemptTimeoutMs, remaining()),
              `${label}.fallback[${i}]`,
            );
            log.info({ label, fallbackIndex: i }, "Fallback model answered");
            return reply;
          } catch (fbErr) {
            if (!isModelFallbackError(fbErr)) throw fbErr;
            lastErr = fbErr;
            log.warn(
              { label, fallbackIndex: i, err: fbErr instanceof Error ? fbErr.message : String(fbErr) },
              "Fallback model also failed retriably — trying next",
            );
          }
        }
        // Chain exhausted. The free fallbacks share daily quotas and often 429
        // together while the primary's 5xx is a seconds-long spike (2026-07-12
        // 68eae59d killed a founder turn this way) — give the primary ONE more
        // shot after a short pause before failing the turn, budget permitting.
        if (remaining() <= retryDelayMs) {
          log.warn({ label, budgetMs }, "Resolution budget exhausted — skipping post-chain primary retry");
          throw lastErr;
        }
        await sleep(retryDelayMs);
        try {
          const reply = await raceWithDeadline(
            primary.invoke(messages),
            Math.min(attemptTimeoutMs, remaining()),
            `${label}.post-chain`,
          );
          log.info({ label }, "Primary model recovered on post-chain retry");
          return reply;
        } catch (retryErr) {
          log.warn(
            { label, err: retryErr instanceof Error ? retryErr.message : String(retryErr) },
            "Primary retry after chain exhaustion also failed — turn fails",
          );
          throw retryErr;
        }
      }
    },
    bindTools(tools: KernelTool[]): KernelChatModel {
      const bind = (m: KernelBindableModel): KernelBindableModel =>
        m.bindTools ? m.bindTools(tools) : m;
      return withModelFallbacks(bind(primary), fallbacks.map(bind), label, options);
    },
  };
}
