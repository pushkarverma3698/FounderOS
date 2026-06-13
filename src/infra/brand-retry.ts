/**
 * FounderOS — Brand-validation retry bounding
 * ===========================================
 * The brand validator (src/infra/brand-validator.ts) returns an error string on
 * violations so the ReAct agent self-corrects and re-calls the send/post tool.
 * That retry loop was UNBOUNDED: when the model oscillates around the word-count
 * boundary (observed 146 → 113 → 146 …) it never converges and re-calls the tool
 * until OFFICE_RECURSION_LIMIT → GraphRecursionError (rule #16: push convergence
 * into deterministic code, never trust the model to stop on its own).
 *
 * This module is the deterministic convergence cap. It counts brand-validation
 * failures per drafting session (keyed by thread + channel) and tells the caller
 * when to STOP re-drafting and instead surface the closest draft to the founder
 * via HITL with the violations noted.
 *
 * In-memory by design: the oscillation happens within a single ReAct run (seconds).
 * A TTL reset means a later, unrelated drafting task on the same persistent thread
 * always starts from a clean count — no cross-task contamination, no unbounded map.
 */

/** Max brand-validation failures before we stop re-drafting and gate the best draft. */
export const BRAND_MAX_RETRIES = 2;

/** A failure older than this is treated as a new drafting session (count resets). */
export const BRAND_RETRY_TTL_MS = 5 * 60_000;

interface Attempt {
  count: number;
  ts: number;
}

const attempts = new Map<string, Attempt>();

/** Stable per-drafting-session key. Falls back to a constant when no thread is set. */
export function brandRetryKey(threadId: string | undefined, channel: string): string {
  return `${threadId ?? "no-thread"}::${channel}`;
}

/**
 * Record a brand-validation failure and return the running attempt count for this
 * session. A gap longer than the TTL since the last failure resets the count to 1.
 */
export function recordBrandFailure(key: string, now: number = Date.now()): number {
  const prev = attempts.get(key);
  const count = prev && now - prev.ts < BRAND_RETRY_TTL_MS ? prev.count + 1 : 1;
  attempts.set(key, { count, ts: now });
  return count;
}

/** Clear the retry count for a session (call after a draft passes the gate). */
export function clearBrandRetries(key: string): void {
  attempts.delete(key);
}

/** Test/diagnostic helper — current count without recording (0 if none/expired). */
export function brandRetryCount(key: string, now: number = Date.now()): number {
  const prev = attempts.get(key);
  if (!prev || now - prev.ts >= BRAND_RETRY_TTL_MS) return 0;
  return prev.count;
}

/** Test helper — wipe all tracked sessions. */
export function _resetBrandRetries(): void {
  attempts.clear();
}
