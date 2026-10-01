/**
 * FounderOS — goals: shared row and value types
 * =============================================
 * Narrow, plain shapes the pure modules (pace, render, evaluate, standup) work on.
 * The drizzle row (src/db/goals-schema.ts) carries `numeric` as strings and dates
 * as strings; the repository converts ONCE, at its boundary, into these — so an
 * analyzer never sees a column it has no business knowing about.
 */

/** Goal lifecycle. Nothing is ever deleted: `done` and `dropped` keep their row and their reviews. */
export const GOAL_STATUSES = ["active", "blocked", "done", "dropped"] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

/**
 * How a metric behaves over time. `rolling` = a count over the last 7 days, compared straight to the
 * target (a sustained rate). `cumulative` = a level that only has to reach the target once, held to a
 * straight line from (created, baseline) to (due, target).
 */
export type MetricKind = "rolling" | "cumulative";

/** How a goal is doing against its target. `unknown` is a real answer: never a made-up pace. */
export const PACES = ["ahead", "on_track", "behind", "unknown"] as const;
export type Pace = (typeof PACES)[number];

export interface GoalRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly title: string;
  readonly metric_key: string;
  readonly metric_arg: string | null;
  /** Finite number: parsed from the `numeric` string at the repository boundary. */
  readonly target: number;
  readonly baseline: number;
  /** LOCAL date `YYYY-MM-DD` in the app timezone, or null for no deadline. */
  readonly due_on: string | null;
  readonly status: GoalStatus;
  readonly blocked_until: Date | null;
  readonly blocker: string | null;
  readonly priority: number;
  /** What `/goal <n> <value>` recorded for a `manual` goal; null until the first report. */
  readonly manual_value: number | null;
  readonly manual_value_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface NewGoal {
  readonly title: string;
  readonly metric_key: string;
  readonly metric_arg: string | null;
  readonly target: number;
  readonly baseline: number;
  readonly due_on: string | null;
  readonly priority: number;
}

export interface ReviewRow {
  readonly goal_id: string;
  /** LOCAL date `YYYY-MM-DD`. */
  readonly review_date: string;
  /** Null when the metric was unavailable or the goal blocked: never a stand-in 0. */
  readonly value: number | null;
  /** Numbers, ids and counts only: this feeds the "Plan next step" prompt. */
  readonly evidence: string;
  readonly pace: Pace;
  readonly error: string | null;
  readonly claimed_at: Date;
  readonly sent_at: Date | null;
  readonly attempts: number;
}

/** What a run computed for one goal, persisted before the message is sent. */
export interface ReviewResult {
  readonly goalId: string;
  readonly value: number | null;
  readonly evidence: string;
  readonly pace: Pace;
  readonly error: string | null;
}
