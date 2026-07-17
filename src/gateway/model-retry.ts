/**
 * FounderOS — LLM retry wrapper: exponential backoff + full jitter.
 * ==================================================================
 * Wraps the kernel's structural model interface so transient provider
 * failures (HTTP 429 rate limits, 529/503 overloaded, 5xx, transport drops —
 * everything is503Error classifies) are absorbed IN PLACE with capped,
 * jittered backoff before the fallback chain has to engage.
 *
 * Layering (kernel-boot): withModelRetry(primary) → withModelFallbacks(...).
 * The SDK's own maxRetries:2 handles sub-second hiccups; this layer handles
 * the seconds-long 429/529 windows that were previously failing straight
 * through to the fallback chain. Jitter decorrelates concurrent turns so
 * they don't re-stampede the provider on the same beat (thundering herd).
 *
 * NOT retried here: 401/403 (fail loud — misconfig), 404 (model retirement —
 * that is the fallback chain's job), or any non-provider error. Sleeper and
 * rng are injectable so tests run deterministic and instant.
 */

import type { KernelBindableModel, KernelChatModel, KernelTool } from "../kernel/index.js";
import { is503Error } from "../agents/model.js";
import { raceWithDeadline } from "./model-deadline.js";
import { childLogger } from "../infra/logger.js";

const log = childLogger({ module: "model-retry" });

/** Backoff ceilings per attempt; actual delay is jittered in (ceiling/2, ceiling]. */
export const MODEL_RETRY_BACKOFF_MS: readonly number[] = [1_000, 2_000, 4_000];

/**
 * Hard deadline for ONE model.invoke attempt. 2026-07-17: storm-degraded but
 * SUCCESSFUL Gemini calls ran up to ~35s, so this must stay comfortably above
 * that; hung calls previously ran unbounded (254s observed) until the turn
 * watchdog killed the whole turn.
 */
export const MODEL_ATTEMPT_TIMEOUT_MS = 45_000;

/**
 * Total wall-clock budget for the retry loop. Once exceeded, remaining
 * scheduled retries are dropped and the last provider error surfaces to the
 * fallback chain — bounded work per layer keeps the whole model stack inside
 * OFFICE_TURN_TIMEOUT_MS.
 */
export const MODEL_RETRY_BUDGET_MS = 90_000;

export interface ModelRetryOptions {
  /** Per-retry delay ceilings (length = max retries). Default MODEL_RETRY_BACKOFF_MS. */
  backoffMs?: readonly number[];
  /** Hard deadline per attempt. Default MODEL_ATTEMPT_TIMEOUT_MS. */
  attemptTimeoutMs?: number;
  /** Total wall-clock budget across attempts. Default MODEL_RETRY_BUDGET_MS. */
  budgetMs?: number;
  /** Injectable clock for tests. Defaults to Date.now. */
  now?: () => number;
  /** Injectable for tests. Defaults to setTimeout. */
  sleeper?: (ms: number) => Promise<void>;
  /** Injectable for tests. Defaults to Math.random. */
  rng?: () => number;
  /** Log label so planner/worker/synthesizer retries are distinguishable. */
  label?: string;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Equal jitter: half the ceiling fixed + half random — bounded below, decorrelated above. */
export function jitteredDelay(ceilingMs: number, rng: () => number): number {
  return Math.round(ceilingMs / 2 + rng() * (ceilingMs / 2));
}

/**
 * Wrap a model so invoke() retries transient provider errors with jittered
 * exponential backoff. bindTools re-wraps the BOUND model, preserving tool
 * binding through the retry layer (same pattern as withModelFallbacks).
 */
export function withModelRetry(
  model: KernelBindableModel,
  options: ModelRetryOptions = {},
): KernelBindableModel {
  const backoff = options.backoffMs ?? MODEL_RETRY_BACKOFF_MS;
  const attemptTimeoutMs = options.attemptTimeoutMs ?? MODEL_ATTEMPT_TIMEOUT_MS;
  const budgetMs = options.budgetMs ?? MODEL_RETRY_BUDGET_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleeper ?? defaultSleep;
  const rng = options.rng ?? Math.random;
  const label = options.label ?? "kernel";

  return {
    async invoke(messages) {
      const started = now();
      let lastErr: unknown;
      for (let attempt = 0; attempt <= backoff.length; attempt += 1) {
        try {
          return await raceWithDeadline(model.invoke(messages), attemptTimeoutMs, label);
        } catch (err) {
          if (!is503Error(err)) throw err; // auth/404/logic errors: not ours to absorb
          lastErr = err;
          if (attempt === backoff.length) break;
          if (now() - started >= budgetMs) {
            log.warn(
              { label, attempt: attempt + 1, elapsedMs: now() - started, budgetMs },
              "Retry budget exhausted — surfacing the provider error to the fallback chain",
            );
            break;
          }
          const delay = jitteredDelay(backoff[attempt]!, rng);
          log.warn(
            { label, attempt: attempt + 1, delayMs: delay, err: err instanceof Error ? err.message : String(err) },
            "Transient provider error — backing off before retry",
          );
          await sleep(delay);
        }
      }
      throw lastErr;
    },
    bindTools(tools: KernelTool[]): KernelChatModel {
      const bound = model.bindTools ? model.bindTools(tools) : model;
      return withModelRetry(bound as KernelBindableModel, options);
    },
  };
}
