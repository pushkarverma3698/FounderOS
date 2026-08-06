/**
 * FounderOS — proof that the lane is alive
 * ========================================
 * The free lane sweeps 48 times a day and most sweeps find nothing. That leaves
 * two failure directions that are indistinguishable from outside, and both are
 * silent by default:
 *
 *   · a healthy lane with a quiet market sends nothing
 *   · a broken lane that polled zero boards ALSO sends nothing
 *
 * The obvious fix — message every sweep — fails a different way. Forty-eight
 * identical "nothing new" pings a day is a channel the founder learns to swipe
 * away, and the one that says something different gets swiped with the rest.
 * So: anything genuinely new interrupts immediately, and quiet sweeps are rolled
 * up into one periodic ping that carries what it actually checked.
 *
 * Every function here is pure and takes `now`. The single mutable reference
 * lives in sweep-runner.ts, so this whole decision table is unit-testable
 * without a clock, a network, or a bot.
 */

import { esc } from "./telegram-format.js";
import type { IngestLine } from "./ingest-batch.js";

/** How long a quiet lane may go without saying anything at all. */
export const ALIVE_PING_INTERVAL_MS = 3 * 60 * 60 * 1000;

/** Rows named individually in a new-roles alert before it summarises the rest. */
export const NEW_ROWS_NAMED = 3;

export interface HeartbeatState {
  /** Sweeps that found nothing since the last message of any kind. */
  readonly quietSweeps: number;
  /** Boards polled across those sweeps — the number that proves work happened. */
  readonly boardsPolled: number;
  /** When the founder last heard from this lane, epoch ms. */
  readonly lastMessageAt: number;
}

export function initialHeartbeat(now: Date): HeartbeatState {
  return { quietSweeps: 0, boardsPolled: 0, lastMessageAt: now.getTime() };
}

/**
 * Fold a sweep that found nothing into the state, and say whether it is time to
 * prove the lane is alive.
 *
 * Returns the ping text rather than sending it — the caller owns the transport,
 * and a function that both decides and sends cannot be tested without one.
 */
export function afterQuietSweep(
  state: HeartbeatState,
  boardsPolled: number,
  now: Date,
  sheetLink: string | null,
): { readonly next: HeartbeatState; readonly ping: string | null } {
  const pending: HeartbeatState = {
    quietSweeps: state.quietSweeps + 1,
    boardsPolled: state.boardsPolled + boardsPolled,
    lastMessageAt: state.lastMessageAt,
  };

  if (now.getTime() - state.lastMessageAt < ALIVE_PING_INTERVAL_MS) {
    return { next: pending, ping: null };
  }

  return {
    next: initialHeartbeat(now),
    ping: formatAlivePing(pending, sheetLink),
  };
}

/**
 * Record that the founder was just told something real.
 *
 * A new-roles alert proves the lane is alive as conclusively as a ping does, so
 * it resets the clock. Otherwise a busy morning would earn him an alert AND a
 * "still alive" ping ten minutes later.
 */
export function afterSpokenSweep(now: Date): HeartbeatState {
  return initialHeartbeat(now);
}

/**
 * The quiet-period ping.
 *
 * Carries the boards-polled count because "alive" on its own is the claim, and
 * the count is the evidence. A ping that said only "alive" would still be sent
 * by a lane whose registry had shrunk to nothing.
 */
export function formatAlivePing(state: HeartbeatState, sheetLink: string | null): string {
  const sweeps = state.quietSweeps;
  return (
    `✅ <b>Job lane alive</b> — ${sweeps} sweep${sweeps === 1 ? "" : "s"} since the last update, ` +
    `${state.boardsPolled.toLocaleString()} board checks, nothing new that cleared screening.` +
    (sheetLink ? `\n${sheetLink}` : "")
  );
}

/**
 * The alert for rows that are BOTH new and worth acting on.
 *
 * No `/draft` numbers in the message itself. Those are pinned by the ranking
 * that runs before the export, and the numbers live in the Sheet next to the
 * row they belong to — printing a second set here would give the founder two
 * numbering schemes for the same jobs and no way to tell which one `/draft`
 * meant.
 */
export function formatNewRowsAlert(
  passes: readonly IngestLine[],
  sheetLink: string | null,
): string {
  const named = passes.slice(0, NEW_ROWS_NAMED);
  const rows = named.map((p) => `• ${esc(p.company)} — ${esc(p.title)}`).join("\n");
  const rest =
    passes.length > NEW_ROWS_NAMED
      ? `\n<i>+ ${passes.length - NEW_ROWS_NAMED} more in the sheet.</i>`
      : "";

  return (
    `🆕 <b>${passes.length} new role${passes.length === 1 ? "" : "s"} passed screening</b>\n` +
    rows +
    rest +
    (sheetLink ? `\n\n${sheetLink}` : "\n\nAsk for the job brief for the full ranking.")
  );
}

/** The link line, or nothing when the Sheet is not configured yet. */
export function sheetLine(url: string | null): string | null {
  return url === null ? null : `📊 <a href="${url}">Open the job sheet</a>`;
}
