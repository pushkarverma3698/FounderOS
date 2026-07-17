/**
 * FounderOS — per-call model deadline
 * ===================================
 * 2026-07-17 prod incident: during a Gemini 503 storm, individual model HTTP
 * calls ran 35–45s before failing and one in-flight fallback call sat 254s
 * with no per-request timeout, so the retry × fallback stack outlived the
 * 300s turn watchdog on every turn — the founder saw generic 5-minute hangs
 * instead of the real provider error.
 *
 * This is the single primitive both wrappers use to bound one model.invoke:
 * race it against a hard deadline. The loser is marked handled (a late
 * rejection must never hit the fatal unhandledRejection handler — same
 * guarantee as gateway/turn-timeout.ts). Note the race does NOT cancel the
 * underlying HTTP request; it bounds how long the caller WAITS, which is what
 * keeps the retry/fallback layers inside the turn budget.
 */

/**
 * Thrown when a single model call exceeds its deadline. `code = "ETIMEDOUT"`
 * puts it in is503Error's transport class, so the retry layer absorbs it and
 * the fallback chain engages — a hung call behaves exactly like a dropped
 * connection instead of a silent stall.
 */
export class ModelCallTimeoutError extends Error {
  override readonly name = "ModelCallTimeoutError";
  readonly code = "ETIMEDOUT";
  readonly ms: number;
  constructor(ms: number, label: string) {
    super(`Model call exceeded ${ms}ms (${label}) — treating as a transport timeout.`);
    this.ms = ms;
  }
}

/**
 * Race `promise` against a hard deadline. Resolves/rejects with the promise's
 * own outcome if it settles first; rejects with {@link ModelCallTimeoutError}
 * if the deadline wins. A non-positive `ms` disables the guard. The timer is
 * always cleared so a settled call never keeps the event loop alive.
 */
export function raceWithDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return promise;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      // The abandoned call settles later (late reply or provider error) —
      // mark it handled so it cannot trip the fatal unhandledRejection handler.
      promise.catch(() => undefined); // allow-failopen: the timeout error below is the one propagating to the caller
      reject(new ModelCallTimeoutError(ms, label));
    }, ms);
  });

  return Promise.race([promise, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  }) as Promise<T>;
}
