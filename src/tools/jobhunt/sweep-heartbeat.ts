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
import type { FreeFunnel } from "./free-ingest.js";

/** How long a quiet lane may go without saying anything at all. */
export const ALIVE_PING_INTERVAL_MS = 3 * 60 * 60 * 1000;

/** Rows named individually in a new-roles alert before it summarises the rest. */
export const NEW_ROWS_NAMED = 3;

/** Number of consecutive 0-pass sweeps before raising a closed-funnel alert. */
export const ZERO_PASS_STREAK_THRESHOLD = 6;

export interface HeartbeatState {
  /** Sweeps that found nothing since the last message of any kind. */
  readonly quietSweeps: number;
  /** Boards polled across those sweeps — the number that proves work happened. */
  readonly boardsPolled: number;
  /** When the founder last heard from this lane, epoch ms. */
  readonly lastMessageAt: number;
  /** Consecutive sweeps where 0 candidates reached screening/passed. */
  readonly zeroPassStreak: number;
  /** Last sweep's funnel diagnostic snapshot. */
  readonly lastFunnel: FreeFunnel | null;
}

export function initialHeartbeat(now: Date): HeartbeatState {
  return { quietSweeps: 0, boardsPolled: 0, lastMessageAt: now.getTime(), zeroPassStreak: 0, lastFunnel: null };
}

/**
 * The stage that took the survivors to ZERO — not the stage with the biggest
 * count.
 *
 * Those are different questions and only one of them is actionable. `stale` is
 * the first filter and is the largest stage on every real sweep this lane has
 * ever run (25,139 of 46,991 on 2026-09-06), on a healthy day and during a total
 * outage alike — a number that reads identically in both states says nothing
 * about either. This alert exists ONLY to explain a closed funnel, so it must
 * name the gate the last survivor died at.
 *
 * MEASURED, 2026-09-06: the free lane produced zero rows for thirty hours while
 * seven postings a sweep reached the final gate and were dropped as `bodyless`
 * (six Lever postings whose HTML body the mapper did not read). Under the old
 * rule this alert would have blamed 25,139 stale postings and sent the founder
 * to the freshness window, which was working correctly.
 *
 * Returns null when the funnel is not closed: a lane that screened something has
 * nothing to explain.
 */
export function funnelClosingStage(
  funnel: FreeFunnel | null | undefined,
): { reason: string; count: number } | null {
  if (!funnel || funnel.screened > 0) return null;

  // PIPELINE ORDER, not any other order — the walk below is only meaningful if
  // it matches the order runFreeIngest actually applies the gates in.
  const stages: Array<{ reason: string; count: number }> = [
    { reason: "undated publication", count: funnel.undated },
    { reason: "stale age cutoff", count: funnel.stale },
    { reason: "off-track title", count: funnel.offTrack },
    { reason: "outside target market", count: funnel.offMarket },
    { reason: "already known in tracker", count: funnel.known },
    { reason: "no body description", count: funnel.bodyless },
  ];

  let remaining = funnel.seen;
  let closer: { reason: string; count: number } | null = null;
  for (const stage of stages) {
    if (stage.count === 0) continue;
    remaining -= stage.count;
    closer = stage;
    if (remaining <= 0) break;
  }
  return closer;
}

/**
 * Fold a sweep that found nothing into the state, and say whether it is time to
 * prove the lane is alive or raise a zero-pass streak alert.
 */
export function afterQuietSweep(
  state: HeartbeatState,
  boardsPolled: number,
  arg3?: Date | FreeFunnel | null,
  arg4?: Date | string | null,
  arg5?: string | null,
  arg6?: { candidateName: string } | null,
): { readonly next: HeartbeatState; readonly ping: string | null } {
  let funnel: FreeFunnel | null = null;
  let currentNow: Date;
  let sheetLink: string | null = null;
  let profile: { candidateName: string } | null = null;

  if (arg3 instanceof Date) {
    currentNow = arg3;
    sheetLink = (arg4 as string | null) ?? null;
    profile = (arg5 as { candidateName: string } | null) ?? null;
  } else {
    funnel = arg3 ?? null;
    currentNow = (arg4 as Date) ?? new Date();
    sheetLink = arg5 ?? null;
    profile = arg6 ?? null;
  }

  const zeroPass = funnel ? funnel.screened === 0 : true;
  const newStreak = zeroPass ? state.zeroPassStreak + 1 : 0;

  const pending: HeartbeatState = {
    quietSweeps: state.quietSweeps + 1,
    boardsPolled: state.boardsPolled + boardsPolled,
    lastMessageAt: state.lastMessageAt,
    zeroPassStreak: newStreak,
    lastFunnel: funnel ?? state.lastFunnel,
  };

  const who = profile?.candidateName ? ` for ${esc(profile.candidateName)}` : "";

  // Zero-pass streak alert: if funnel drops 100% for N consecutive sweeps, raise alert once at threshold
  if (newStreak === ZERO_PASS_STREAK_THRESHOLD) {
    const top = funnelClosingStage(funnel ?? state.lastFunnel);
    const dropClause = top ? ` (the last ${top.count} died at: ${top.reason})` : "";
    const ping =
      `⚠ <b>Job lane funnel alert${who}</b> — 0 candidates passed for ${newStreak} consecutive sweeps` +
      `${dropClause}. The funnel may be restricted or closed.`;
    return {
      next: { ...pending, lastMessageAt: currentNow.getTime() },
      ping,
    };
  }

  if (currentNow.getTime() - state.lastMessageAt < ALIVE_PING_INTERVAL_MS) {
    return { next: pending, ping: null };
  }

  return {
    next: initialHeartbeat(currentNow),
    ping: formatAlivePing(pending, sheetLink, profile),
  };
}

/**
 * Record that the founder was just told something real.
 */
export function afterSpokenSweep(now: Date): HeartbeatState {
  return initialHeartbeat(now);
}

/**
 * The quiet-period ping.
 */
export function formatAlivePing(state: HeartbeatState, sheetLink: string | null, profile?: { candidateName: string } | null): string {
  const sweeps = state.quietSweeps;
  const top = funnelClosingStage(state.lastFunnel);
  const dropInfo = top ? ` The last ${top.count.toLocaleString()} died at: ${top.reason}.` : "";
  const who = profile?.candidateName ? ` for ${esc(profile.candidateName)}` : "";
  return (
    `✅ <b>Job lane alive${who}</b> — ${sweeps} sweep${sweeps === 1 ? "" : "s"} since the last update, ` +
    `${state.boardsPolled.toLocaleString()} board checks, nothing new that cleared screening.${dropInfo}` +
    (sheetLink ? `\n${sheetLink}` : "") +
    `\n${NEXT_STEP_LINE}`
  );
}

/**
 * What to do next, named as commands rather than implied.
 *
 * UNCONDITIONAL, and that is the point. Until 2026-08-21 this tail was a Google
 * Sheet link — and because the Sheet was never configured, `sheetLink` was null
 * on every sweep and the founder was told to "ask for the job brief", which is a
 * phrase, not a control. `/draft` and `/applied` were not invoked once in seven
 * days of logs. An alert whose call to action is a sentence someone has to
 * rephrase is an alert that ends in nothing.
 */
export const NEXT_STEP_LINE =
  "→ /jobs for the ranked list · /csv for the file · /draft &lt;n&gt; to apply";

/**
 * The alert for rows that are BOTH new and worth acting on.
 */
export function formatNewRowsAlert(
  passes: readonly IngestLine[],
  sheetLink: string | null,
  candidateName?: string,
): string {
  const named = passes.slice(0, NEW_ROWS_NAMED);
  const rows = named.map((p) => `• ${esc(p.company)} — ${esc(p.title)}`).join("\n");
  const rest =
    passes.length > NEW_ROWS_NAMED
      ? `\n<i>+ ${passes.length - NEW_ROWS_NAMED} more.</i>`
      : "";

  // NAMED once there is more than one candidate. Two identical "3 new roles
  // passed screening" alerts thirty minutes apart, for two different people, is
  // a channel the founder learns to ignore — and acting on the wrong one costs
  // an application.
  const who = candidateName ? ` for ${esc(candidateName)}` : "";

  return (
    `🆕 <b>${passes.length} new role${passes.length === 1 ? "" : "s"} passed screening${who}</b>\n` +
    rows +
    rest +
    (sheetLink ? `\n\n${sheetLink}` : "") +
    `\n\n${NEXT_STEP_LINE}`
  );
}

/** The link line, or nothing when the Sheet is not configured yet. */
export function sheetLine(url: string | null): string | null {
  return url === null ? null : `📊 <a href="${url}">Open the job sheet</a>`;
}
