/**
 * FounderOS — turn-level timeout guard
 * ====================================
 * A hung `office.invoke` (a model or tool that never returns and never throws)
 * is the worst failure mode: the founder sees the typing indicator forever and
 * gets NO reply. Unit tests and a clean local run never catch it — only a real
 * hang does (rule #19/#22, fail-loud). This wraps an invoke in a deadline so the
 * gateway can abort LOUD instead of hanging SILENT.
 *
 * Note: `Promise.race` does not cancel the underlying work — the hung invoke may
 * keep running in the background. That's acceptable: we release the chat-turn lock,
 * tell the founder, and clear the thread so the next message runs clean. Bounding
 * the wait is what matters; the orphaned promise is harmless (no side effect runs
 * without HITL approval, rule #4).
 */

/** Thrown when an office turn exceeds OFFICE_TURN_TIMEOUT_MS. */
export class TurnTimeoutError extends Error {
  override readonly name = "TurnTimeoutError";
  readonly ms: number;
  readonly label: string;
  constructor(ms: number, label: string) {
    super(`Office turn exceeded ${ms}ms (${label}) and was aborted to avoid a silent hang.`);
    this.ms = ms;
    this.label = label;
  }
}

/**
 * Race `promise` against a deadline. Resolves with the promise's value if it
 * settles first; rejects with {@link TurnTimeoutError} if the deadline wins.
 * A non-positive `ms` disables the guard (returns the promise unchanged).
 *
 * The timer is always cleared (success, failure, or timeout) so a resolved turn
 * never keeps the event loop alive.
 */
export function withTurnTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label = "office.invoke",
): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return promise;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new TurnTimeoutError(ms, label)), ms);
  });

  return Promise.race([promise, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  }) as Promise<T>;
}
