/**
 * FounderOS — goals: pace and completion (pure)
 * =============================================
 * Progress comes from real events, so "how is this goal doing" is arithmetic on numbers the
 * code already holds — no model, no clock read, no I/O. The caller passes `today` (a local
 * date key), so every boundary is testable with literals.
 *
 * Two kinds of metric behave differently (see MetricKind):
 *   rolling      a count over the last 7 days. Compared straight to the target. Calendar-free:
 *                a rate goal has a pace on day one and without a deadline.
 *   cumulative   a level that only has to reach the target once. Held to a straight line from
 *                (created, baseline) to (due, target). With no due date the line does not
 *                exist, so the answer is `unknown` — never a made-up pace.
 */

import { daysBetween } from "./local-date.js";
import type { MetricKind, Pace } from "./types.js";

/** How far above the straight line, as a fraction of (target − baseline), counts as "ahead" rather than "on track". */
export const PACE_AHEAD_MARGIN = 0.1;

export interface PaceInput {
  readonly kind: MetricKind;
  /** null = the metric could not be read; there is no pace to compute. */
  readonly value: number | null;
  readonly target: number;
  readonly baseline: number;
  /** Local date the goal was created. */
  readonly createdOn: string;
  /** Local date the goal is due, or null for no deadline. */
  readonly dueOn: string | null;
  /** Today's local date. */
  readonly today: string;
}

function isUsable(n: number | null): n is number {
  return n !== null && Number.isFinite(n);
}

export function computePace(input: PaceInput): Pace {
  const { value, target, baseline, dueOn, today } = input;
  if (!isUsable(value) || !Number.isFinite(target) || !Number.isFinite(baseline)) return "unknown";

  if (input.kind === "rolling") {
    if (value > target) return "ahead";
    return value === target ? "on_track" : "behind";
  }

  // Cumulative, target reached: early is ahead; on or after the due day (or with no deadline), on track.
  if (value >= target) return dueOn !== null && today < dueOn ? "ahead" : "on_track";
  if (dueOn === null) return "unknown";

  const totalDays = daysBetween(input.createdOn, dueOn);
  const elapsedDays = daysBetween(input.createdOn, today);
  // Already due (due on or before creation) means the whole target was expected from the start.
  const fraction = totalDays <= 0 ? 1 : Math.min(1, Math.max(0, elapsedDays / totalDays));
  const span = target - baseline;
  // Below the target with the target at or under the baseline: no line to be on.
  if (span <= 0) return "behind";
  const expected = baseline + span * fraction;
  if (value >= expected + PACE_AHEAD_MARGIN * span) return "ahead";
  return value >= expected ? "on_track" : "behind";
}

export interface CompletionInput {
  readonly kind: MetricKind;
  readonly value: number | null;
  readonly target: number;
  readonly dueOn: string | null;
  readonly today: string;
}

/**
 * Does this goal close itself?
 *
 * A cumulative goal is done the moment its value reaches the target (this is also "target
 * already met when added": it closes at the first standup, with its evidence). A rolling goal is a
 * sustained rate: "1 merged fix a week, 1 of 1 ✓ on track" is progress, not a finish line, so it
 * stays open until its due date arrives AND the target is being held. With no due date it never
 * closes by itself; the founder ends it with /goal done.
 */
export function isGoalComplete(input: CompletionInput): boolean {
  const { value, target } = input;
  if (!isUsable(value) || !Number.isFinite(target) || value < target) return false;
  if (input.kind === "cumulative") return true;
  return input.dueOn !== null && input.today >= input.dueOn;
}
