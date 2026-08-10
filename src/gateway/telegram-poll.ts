/**
 * FounderOS — long-poll conflict policy
 * =====================================
 * Pure predicates and timing for Telegram's `409 Conflict: terminated by other
 * getUpdates request`. Split out of telegram.ts so the policy is unit-testable
 * without a Bot, a token or a network.
 *
 * WHY THIS EXISTS. A 409 means a SECOND consumer is holding the same bot token.
 * That is a condition owned by the other process, and it clears on its own the
 * moment that process stops — but the gateway used to `process.exit(1)` on any
 * polling rejection, so a transient overlap became a hard exit, and
 * `Restart=always` turned the hard exit into a loop. Production took 25 conflict
 * crashes and 29 restarts across three windows on 2026-08-08/09.
 *
 * WHAT THIS CANNOT DO. Backing off does not make the second consumer go away,
 * and no host-local lock can: during the 2026-08-09 window the VPS ran exactly
 * one FounderOS process, so the other getUpdates caller was OFF THE BOX. The
 * retry budget below buys time for a deploy overlap or a short-lived dev run to
 * finish; a consumer that never stops still ends in a loud exit, because a bot
 * that silently never polls is worse than one that dies saying why.
 */

/** Telegram's code for "another getUpdates is already running". */
export const CONFLICT_CODE = 409;

/** Retries before we give up and exit loudly. */
export const CONFLICT_MAX_ATTEMPTS = 6;

/** First backoff step; doubles per attempt. */
export const CONFLICT_BASE_DELAY_MS = 2_000;

/** Ceiling per wait — a long conflict must not park the bot for hours. */
export const CONFLICT_MAX_DELAY_MS = 60_000;

/**
 * Is this the "someone else is polling" error, and nothing else?
 *
 * Matches grammY's `GrammyError.error_code` first, then falls back to the
 * message text, because the rejection that reaches `bot.start().catch()` is
 * sometimes a plain Error carrying only the formatted string. The text match is
 * deliberately anchored on `409` NEXT TO `conflict` — a bare `/409/` would
 * classify any message that happens to contain the number.
 */
export function isConflictError(err: unknown): boolean {
  if (err === null || err === undefined) return false;

  const code = (err as { error_code?: unknown }).error_code;
  if (code === CONFLICT_CODE) return true;

  const message = err instanceof Error ? err.message : String(err);
  return /409[^a-z0-9]{0,4}\s*conflict/i.test(message);
}

/**
 * Exponential backoff, capped.
 *
 * `attempt` is 1-based, so the first wait is exactly the base delay — never
 * zero, which would spin against Telegram while the other consumer is still up.
 */
export function conflictBackoffMs(
  attempt: number,
  baseMs: number = CONFLICT_BASE_DELAY_MS,
): number {
  const step = baseMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(step, CONFLICT_MAX_DELAY_MS);
}
