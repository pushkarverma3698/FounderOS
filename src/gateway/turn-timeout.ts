/**
 * FounderOS — turn-level timeout guard
 * ====================================
 * A hung `office.invoke` (a model or tool that never returns and never throws)
 * is the worst failure mode: the founder sees the typing indicator forever and
 * gets NO reply. Unit tests and a clean local run never catch it — only a real
 * hang does (rule #19/#22, fail-loud). This wraps an invoke in a deadline so the
 * gateway can abort LOUD instead of hanging SILENT.
 *
 * `Promise.race` alone does not cancel the underlying work, so callers pass an
 * `onDeadline` that aborts the run's AbortSignal: the orphaned invoke used to
 * keep executing in the background — burning model budget and racing checkpoint
 * writes against the founder's next message. Two guarantees when the deadline
 * fires: the run is actively aborted (not merely abandoned), and the abandoned
 * promise's eventual rejection (AbortError, a late provider error) is marked
 * handled — otherwise it would hit the fatal unhandledRejection handler in
 * src/index.ts and kill the whole process minutes after the founder already
 * got the timeout message.
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
 * `onDeadline` runs when (and only when) the deadline wins — pass the run's
 * AbortController.abort so the orphaned work actually stops instead of racing
 * the next turn. The timer is always cleared (success, failure, or timeout)
 * so a resolved turn never keeps the event loop alive.
 *
 * `onArm`, if given, is called synchronously with a `touch()` function that
 * re-arms the deadline `ms` from NOW. Without this a single graph step that
 * runs one long tool call (e.g. `claude_code`, own budget 15 minutes) yields
 * no intermediate LangGraph state — nothing resets a fixed timer — so the
 * outer guard always fires at `ms` regardless of whether the tool is still
 * genuinely working (AG-015/B5). Callers wire `touch()` to real signs of life
 * (a new graph state, a tool's own progress stream) so a genuinely hung run
 * still times out at `ms` of true silence, while an actively-working one
 * doesn't. Never call `touch()` from a fixed interval — that defeats the
 * guard's entire purpose by masking a real hang.
 */
export function withTurnTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label = "office.invoke",
  onDeadline?: () => void,
  onArm?: (touch: () => void) => void,
): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return promise;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let reject!: (err: unknown) => void;

  const arm = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        onDeadline?.();
      } catch {
        /* allow-failopen: an abort() blip must never mask the timeout rejection below */
      }
      // The abandoned run rejects later (AbortError / late provider error).
      // Mark that rejection handled: the TurnTimeoutError below is the one
      // the caller sees, and an orphaned rejection would otherwise trip the
      // fatal unhandledRejection handler and kill the process.
      promise.catch(() => undefined); // allow-failopen: the timeout error is already propagating to the caller
      reject(new TurnTimeoutError(ms, label));
    }, ms);
  };

  const deadline = new Promise<never>((_resolve, rejectFn) => {
    reject = rejectFn;
    arm();
  });

  onArm?.(arm);

  return Promise.race([promise, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  }) as Promise<T>;
}
