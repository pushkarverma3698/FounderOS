/**
 * FounderOS — goals: evaluating goals (pure over injected sources)
 * ================================================================
 * The standup, `/goals` and `goals:standup --dry-run` all ask the same question of a goal: what is its
 * metric now, how is that against the target, has it finished, is it blocked. This is the one place
 * that answers it, so the three can never disagree. No model, no clock read (the caller passes `now`
 * and `today`), no storage: metric sources arrive as `MetricDeps`.
 *
 * A blocked goal is NOT evaluated: its pace is not computed and its source is not called. A metric
 * that fails comes back with `value: null` and the reason in `error` — the standup prints that reason
 * beside the goal and stores it, and a null value never becomes a 0.
 */

import { localDateKey } from "./local-date.js";
import { evaluateMetric, isMetricKey, metricKind, type MetricDeps, type MetricOutcome } from "./metrics.js";
import { computePace, isGoalComplete } from "./pace.js";
import type { GoalRow, Pace, ReviewResult } from "./types.js";

export interface GoalEvaluation {
  readonly goal: GoalRow;
  /** 1-based position in the ordered open list: the number `/goal <n>` means. */
  readonly number: number;
  readonly blockedNow: boolean;
  /** Was blocked, and the block has now ended: back on the list, said once, flipped to active when the message is delivered. */
  readonly unblockedNow: boolean;
  /** Null when the goal is blocked (nothing was read). */
  readonly outcome: MetricOutcome | null;
  readonly value: number | null;
  /** Numbers, ids and counts only. Empty when the metric was unavailable. */
  readonly evidence: string;
  readonly error: string | null;
  readonly pace: Pace;
  readonly completed: boolean;
}

export interface EvaluateContext {
  readonly now: Date;
  readonly timeZone: string;
  /** Today's local date key. */
  readonly today: string;
  readonly timeoutMs?: number;
}

/** Is this goal blocked at `now`? A block with no end lasts until lifted; one with an end lasts up to it. */
export function blockedNow(goal: GoalRow, now: Date): boolean {
  if (goal.status === "blocked") return goal.blocked_until === null || goal.blocked_until.getTime() > now.getTime();
  // A hand-edited row that is `active` but carries a future blocked_until is still blocked: it must not dodge the rule.
  return goal.status === "active" && goal.blocked_until !== null && goal.blocked_until.getTime() > now.getTime();
}

export function unblockedNow(goal: GoalRow, now: Date): boolean {
  return goal.status === "blocked" && !blockedNow(goal, now);
}

async function evaluateOne(goal: GoalRow, number: number, deps: MetricDeps, ctx: EvaluateContext): Promise<GoalEvaluation> {
  const blocked = blockedNow(goal, ctx.now);
  const base = { goal, number, blockedNow: blocked, unblockedNow: unblockedNow(goal, ctx.now) };
  if (blocked) {
    const evidence = goal.blocked_until === null ? "blocked (no end date)" : `blocked until ${localDateKey(goal.blocked_until, ctx.timeZone)}`;
    return { ...base, outcome: null, value: null, evidence, error: null, pace: "unknown", completed: false };
  }

  const outcome = await evaluateMetric(goal, deps, {
    now: ctx.now,
    timeZone: ctx.timeZone,
    ...(ctx.timeoutMs !== undefined ? { timeoutMs: ctx.timeoutMs } : {}),
  });
  const value = outcome.ok ? outcome.value : null;
  // An unknown key has no kind; its value is null, so the kind cannot change the answer.
  const kind = isMetricKey(goal.metric_key) ? metricKind(goal.metric_key) : "rolling";
  const pace = computePace({
    kind,
    value,
    target: goal.target,
    baseline: goal.baseline,
    createdOn: localDateKey(goal.created_at, ctx.timeZone),
    dueOn: goal.due_on,
    today: ctx.today,
  });
  const completed = isGoalComplete({ kind, value, target: goal.target, dueOn: goal.due_on, today: ctx.today });
  return { ...base, outcome, value, evidence: outcome.ok ? outcome.evidence : "", error: outcome.ok ? null : outcome.error, pace, completed };
}

/** Evaluate every goal, concurrently: each source has its own timeout, so one dead source holds up no other. */
export function evaluateGoals(
  goals: readonly GoalRow[],
  numbering: ReadonlyMap<string, number>,
  deps: MetricDeps,
  ctx: EvaluateContext,
): Promise<GoalEvaluation[]> {
  return Promise.all(goals.map((goal) => evaluateOne(goal, numbering.get(goal.id) ?? 0, deps, ctx)));
}

/** What is stored for this goal's review row before the message is sent. */
export function toReviewResult(e: GoalEvaluation): ReviewResult {
  return { goalId: e.goal.id, value: e.value, evidence: e.evidence, pace: e.pace, error: e.error };
}
