/**
 * FounderOS — goals: the Postgres repository
 * ==========================================
 * Implements GoalRepo (repo.ts) over agents.goals and agents.goal_reviews. The only place `numeric`
 * strings are parsed and `date` strings and `timestamp` Dates cross into the plain types the rest of
 * src/goals works on. Held to the same contract as the in-memory fake by
 * tests/integration/goals-postgres.test.ts.
 *
 * THE CLAIM is the one statement that matters. `claimReviews` writes every review row for a run in ONE
 * `INSERT … ON CONFLICT (goal_id, review_date) DO UPDATE … WHERE sent_at IS NULL AND claimed_at < cutoff`,
 * rows in goal-id order:
 *   - a fresh row is inserted (attempt 1);
 *   - a row whose run died before sending (sent_at NULL, claimed_at older than the lease) is retaken
 *     (attempts + 1) — the plan's insert-and-do-nothing claim would have kept it forever, losing the day;
 *   - a delivered row, or one another run holds inside its lease, is left alone.
 * Two runs that start together serialise on the first contended row (same order, so no deadlock): the
 * second finds every row claimed and takes none, which is why one standup is one message.
 */

import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { goalReviews, goals, type GoalRecord, type GoalReviewRecord } from "../db/schema.js";
import { parseNumeric } from "./numeric.js";
import type { ClaimSummary, FinalizeInput, GoalRepo, StatusChange } from "./repo.js";
import { GOAL_STATUSES, PACES, type GoalRow, type GoalStatus, type NewGoal, type Pace, type ReviewResult, type ReviewRow } from "./types.js";

type Db = ReturnType<typeof getDb>;

const OPEN: GoalStatus[] = ["active", "blocked"];

function toGoalRow(r: GoalRecord): GoalRow {
  const target = parseNumeric(r.target);
  const baseline = parseNumeric(r.baseline);
  if (target === null || baseline === null) {
    throw new Error(`goal ${r.id}: the stored target or baseline is not a finite number, so the goal cannot be evaluated`);
  }
  if (!(GOAL_STATUSES as readonly string[]).includes(r.status)) throw new Error(`goal ${r.id}: unknown status '${r.status}'`);
  return {
    id: r.id,
    tenant_id: r.tenant_id,
    title: r.title,
    metric_key: r.metric_key,
    metric_arg: r.metric_arg,
    target,
    baseline,
    due_on: r.due_on,
    status: r.status as GoalStatus,
    blocked_until: r.blocked_until,
    blocker: r.blocker,
    priority: r.priority,
    // An unreadable stored manual value is treated as "not reported", which the metric reports as unavailable.
    manual_value: parseNumeric(r.manual_value),
    manual_value_at: r.manual_value_at,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function toReviewRow(r: GoalReviewRecord): ReviewRow {
  return {
    goal_id: r.goal_id,
    review_date: r.review_date,
    value: parseNumeric(r.value),
    evidence: r.evidence,
    pace: (PACES as readonly string[]).includes(r.pace) ? (r.pace as Pace) : "unknown",
    error: r.error,
    claimed_at: r.claimed_at,
    sent_at: r.sent_at,
    attempts: r.attempts,
  };
}

export function createPgGoalRepo(db: Db = getDb()): GoalRepo {
  return {
    async addGoal(tenant: string, goal: NewGoal, now: Date): Promise<GoalRow> {
      const [row] = await db
        .insert(goals)
        .values({
          tenant_id: tenant,
          title: goal.title,
          metric_key: goal.metric_key,
          metric_arg: goal.metric_arg,
          target: String(goal.target),
          baseline: String(goal.baseline),
          due_on: goal.due_on,
          priority: goal.priority,
          created_at: now,
          updated_at: now,
        })
        .returning();
      if (!row) throw new Error("goals insert returned no row");
      return toGoalRow(row);
    },

    async listOpenGoals(tenant: string): Promise<GoalRow[]> {
      const rows = await db
        .select()
        .from(goals)
        .where(and(eq(goals.tenant_id, tenant), inArray(goals.status, OPEN)))
        .orderBy(asc(goals.priority), asc(goals.created_at), asc(goals.id));
      return rows.map(toGoalRow);
    },

    async getGoal(tenant: string, id: string): Promise<GoalRow | null> {
      const [row] = await db.select().from(goals).where(and(eq(goals.tenant_id, tenant), eq(goals.id, id))).limit(1);
      return row ? toGoalRow(row) : null;
    },

    async updateStatus(tenant: string, id: string, change: StatusChange, now: Date): Promise<GoalRow | null> {
      const set =
        change.status === "blocked"
          ? { status: "blocked", blocker: change.blocker, blocked_until: change.blockedUntil, updated_at: now }
          : change.status === "active"
            ? { status: "active", blocker: null, blocked_until: null, updated_at: now }
            : { status: change.status, updated_at: now };
      const [row] = await db.update(goals).set(set).where(and(eq(goals.tenant_id, tenant), eq(goals.id, id))).returning();
      return row ? toGoalRow(row) : null;
    },

    async recordManualValue(tenant: string, id: string, value: number, now: Date): Promise<GoalRow | null> {
      const [row] = await db
        .update(goals)
        .set({ manual_value: String(value), manual_value_at: now, updated_at: now })
        .where(and(eq(goals.tenant_id, tenant), eq(goals.id, id)))
        .returning();
      return row ? toGoalRow(row) : null;
    },

    async claimReviews(tenant: string, goalIds: readonly string[], reviewDate: string, now: Date, leaseMs: number): Promise<ClaimSummary> {
      const wanted = [...new Set(goalIds)];
      if (wanted.length === 0) return { claimed: [], alreadySent: [], leased: [] };
      const owned = await db
        .select({ id: goals.id })
        .from(goals)
        .where(and(eq(goals.tenant_id, tenant), inArray(goals.id, wanted)))
        .orderBy(asc(goals.id));
      const ids = owned.map((r) => r.id);
      if (ids.length === 0) return { claimed: [], alreadySent: [], leased: [] };

      const cutoff = new Date(now.getTime() - leaseMs);
      const taken = await db
        .insert(goalReviews)
        .values(ids.map((goal_id) => ({ goal_id, review_date: reviewDate, claimed_at: now })))
        .onConflictDoUpdate({
          target: [goalReviews.goal_id, goalReviews.review_date],
          set: { claimed_at: now, attempts: sql`${goalReviews.attempts} + 1` },
          setWhere: and(isNull(goalReviews.sent_at), lt(goalReviews.claimed_at, cutoff)),
        })
        .returning({ goalId: goalReviews.goal_id, attempts: goalReviews.attempts });

      const takenIds = new Set(taken.map((t) => t.goalId));
      const rest = ids.filter((id) => !takenIds.has(id));
      const alreadySent: string[] = [];
      const leased: { goalId: string; claimedAt: Date }[] = [];
      if (rest.length > 0) {
        const rows = await db
          .select({ goalId: goalReviews.goal_id, sentAt: goalReviews.sent_at, claimedAt: goalReviews.claimed_at })
          .from(goalReviews)
          .where(and(eq(goalReviews.review_date, reviewDate), inArray(goalReviews.goal_id, rest)));
        for (const r of rows) {
          if (r.sentAt !== null) alreadySent.push(r.goalId);
          else leased.push({ goalId: r.goalId, claimedAt: r.claimedAt });
        }
      }
      return { claimed: [...taken].sort((a, b) => (a.goalId < b.goalId ? -1 : 1)), alreadySent, leased };
    },

    async saveReviewResults(reviewDate: string, results: readonly ReviewResult[]): Promise<void> {
      if (results.length === 0) return;
      await db.transaction(async (tx) => {
        for (const r of results) {
          await tx
            .update(goalReviews)
            .set({ value: r.value === null ? null : String(r.value), evidence: r.evidence, pace: r.pace, error: r.error })
            .where(and(eq(goalReviews.goal_id, r.goalId), eq(goalReviews.review_date, reviewDate)));
        }
      });
    },

    async finalizeReviews(input: FinalizeInput): Promise<void> {
      if (input.goalIds.length === 0 && input.transitions.length === 0) return;
      await db.transaction(async (tx) => {
        if (input.goalIds.length > 0) {
          await tx
            .update(goalReviews)
            .set({ sent_at: input.sentAt })
            .where(and(eq(goalReviews.review_date, input.reviewDate), inArray(goalReviews.goal_id, [...input.goalIds]), isNull(goalReviews.sent_at)));
        }
        for (const t of input.transitions) {
          await tx
            .update(goals)
            .set(t.to === "active" ? { status: "active", blocker: null, blocked_until: null, updated_at: input.sentAt } : { status: t.to, updated_at: input.sentAt })
            .where(eq(goals.id, t.goalId));
        }
      });
    },

    async hasSentReview(tenant: string, reviewDate: string): Promise<boolean> {
      const rows = await db
        .select({ one: sql<number>`1` })
        .from(goalReviews)
        .innerJoin(goals, eq(goals.id, goalReviews.goal_id))
        .where(and(eq(goals.tenant_id, tenant), eq(goalReviews.review_date, reviewDate), isNotNull(goalReviews.sent_at)))
        .limit(1);
      return rows.length > 0;
    },

    async recentReviews(goalId: string, limit: number): Promise<ReviewRow[]> {
      const rows = await db
        .select()
        .from(goalReviews)
        .where(and(eq(goalReviews.goal_id, goalId), or(ne(goalReviews.evidence, ""), isNotNull(goalReviews.error))))
        .orderBy(desc(goalReviews.review_date))
        .limit(limit);
      return rows.map(toReviewRow);
    },
  };
}
