/**
 * Evolution Engine — the two jobhunt DECISION findings.
 * ======================================================
 * Split out of `jobhunt.ts` for its 400-line budget (which re-exports everything here).
 * `lane-silent` and `candidate-not-acting` are questions for the founder, not code:
 * they have no guidance in `jobhunt-guidance.ts`, so `issue-body.ts` refuses to render
 * them and they can only ever reach Telegram. See `jobhunt.ts` for what the plan got
 * wrong about its sources.
 */

import { funnelClosingStage, ZERO_PASS_STREAK_THRESHOLD } from "../../tools/jobhunt/sweep-heartbeat.js";
import type { Finding } from "../types.js";
import type { JobhuntSnapshot } from "./jobhunt-types.js";

/**
 * Plan C3: "zero_pass_streak >= 6". The same constant the lane's own per-sweep
 * alert fires at (sweep-heartbeat.ts), so this line can never contradict it.
 */
export const LANE_SILENT_MIN_STREAK = ZERO_PASS_STREAK_THRESHOLD;

/** Minutes between free sweeps: `FREE_SWEEP_CRON` is every 30. A test pins the two together. */
export const SWEEP_INTERVAL_MINUTES = 30;

/** Plan C1: "in 14 days". */
export const CANDIDATE_NOT_ACTING_WINDOW_DAYS = 14;

/**
 * Plan C1: "actionable rows >= 20". Measured 2026-09-29 for wife-nl-finance over 30
 * days: 28 do_today + 14 stretch + 20 ask = 62 actionable, with `applied_at` set on
 * 0 rows ever, so 14 days at that rate is about 29 and the check is true today.
 */
export const CANDIDATE_NOT_ACTING_MIN_ACTIONABLE = 20;

function who(row: { readonly profileId: string; readonly candidateName?: string }): string {
  return row.candidateName ? `${row.profileId} (${row.candidateName})` : row.profileId;
}

const isCount = (n: number): boolean => Number.isFinite(n) && n >= 0;

// ── lane-silent (decision) ──────────────────────────────────────────────────────

export function findLaneSilent(snapshot: JobhuntSnapshot): Finding[] {
  return snapshot.laneHeartbeats
    .filter((h) => isCount(h.zeroPassStreak) && h.zeroPassStreak >= LANE_SILENT_MIN_STREAK)
    .map((h): Finding => {
      const hours = (h.zeroPassStreak * SWEEP_INTERVAL_MINUTES) / 60;
      const closing = funnelClosingStage(h.lastFunnel);
      const died = closing ? ` The last ${closing.count.toLocaleString("en-US")} died at: ${closing.reason}.` : "";
      return {
        kind: "lane-silent",
        subject: h.profileId,
        evidence:
          `${who(h)}: 0 new postings reached screening for ${h.zeroPassStreak} consecutive free-lane sweeps ` +
          `(about ${Number.isInteger(hours) ? hours : hours.toFixed(1)} hours).${died} ` +
          `Decide whether the market is genuinely flat for this candidate or a filter has closed the funnel.`,
        severity: "medium",
      };
    });
}

// ── candidate-not-acting (decision) ─────────────────────────────────────────────

export function findCandidateNotActing(snapshot: JobhuntSnapshot): Finding[] {
  return snapshot.applyActivity
    .filter((a) => [a.doToday, a.stretch, a.ask, a.applied, a.skipped].every(isCount))
    .filter((a) => a.doToday + a.stretch + a.ask >= CANDIDATE_NOT_ACTING_MIN_ACTIONABLE && a.applied === 0)
    .map((a): Finding => {
      const actionable = a.doToday + a.stretch + a.ask;
      const reading =
        a.skipped === 0
          ? "Nothing shows the candidate has seen them: either the brief is not being opened, or applications are made " +
            "outside FounderOS and nothing records them."
          : "The candidate is reading the list and passing on it, so the screening is aimed wrong rather than the habit.";
      return {
        kind: "candidate-not-acting",
        subject: a.profileId,
        evidence:
          `${who(a)} has ${actionable} actionable roles from the last ${CANDIDATE_NOT_ACTING_WINDOW_DAYS} days ` +
          `(${a.doToday} do today, ${a.stretch} stretch, ${a.ask} ask), 0 applied and ${a.skipped} skipped. ${reading}`,
        severity: "high",
      };
    });
}
