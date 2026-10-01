/**
 * FounderOS — goals + goal_reviews (Drizzle schema)
 * ==================================================
 * Migration: drizzle/0042_goals.sql. Re-exported from src/db/schema.ts (one line) so
 * tests/unit/db/schema-migration-parity.test.ts sees these tables. A table declared
 * here and NOT re-exported there would be invisible to that guard, which is the
 * 2026-07-29 `scheduled_tasks.recurrence` incident waiting to repeat.
 *
 * Lives in its own file because schema.ts is already far over the 400-line budget.
 * It declares its own `pgSchema("agents")` rather than importing `agentsSchema`:
 * schema.ts re-exports this file, so importing it back would be a cycle in which
 * `agentsSchema` is still uninitialised when this module evaluates.
 *
 * `numeric` columns come back from postgres as STRINGS. Nothing outside the
 * repository layer (src/goals/pg-repo.ts) should read them raw; it parses with
 * `parseNumeric` and checks `Number.isFinite`.
 */

import { sql } from "drizzle-orm";
import { check, date, index, integer, numeric, pgSchema, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

const agents = pgSchema("agents");

/**
 * One row per goal. Nothing is ever deleted: `dropped` and `done` goals keep their
 * row and their reviews, they just leave the ordered list `/goals` numbers.
 */
export const goals = agents.table(
  "goals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: text("tenant_id").notNull(),
    title: text("title").notNull(),
    /** A key of the closed registry in src/goals/metrics.ts. Validated in code, not by a DB enum. */
    metric_key: text("metric_key").notNull(),
    /** The metric's argument (`wife-nl-finance`, `owner/repo`, an action name), when its key takes one. */
    metric_arg: text("metric_arg"),
    target: numeric("target").notNull(),
    /** The value at creation. A cumulative goal's linear pace runs from (created, baseline) to (due, target). */
    baseline: numeric("baseline").notNull().default("0"),
    /** LOCAL date (APP_TIMEZONE) the goal is due. NULL = no deadline, so a cumulative goal's pace is `unknown`. */
    due_on: date("due_on", { mode: "string" }),
    /** active | blocked | done | dropped — CHECK-constrained in the migration. */
    status: text("status").notNull().default("active"),
    blocked_until: timestamp("blocked_until", { withTimezone: true }),
    blocker: text("blocker"),
    /** Lower sorts first. The list order is (priority, created_at), and `/goal <n>` means position n in it. */
    priority: integer("priority").notNull().default(100),
    /** What `/goal <n> <value>` recorded for a `manual` goal. NULL until the first report: never a made-up 0. */
    manual_value: numeric("manual_value"),
    manual_value_at: timestamp("manual_value_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantStatusIdx: index("goals_tenant_status_idx").on(t.tenant_id, t.status),
    statusCheck: check("goals_status_check", sql`${t.status} IN ('active', 'blocked', 'done', 'dropped')`),
  }),
);

/**
 * One row per goal per LOCAL date, and the ledger that makes the standup send once.
 *
 * TWO-PHASE, because "claim the row, then compute and send" loses the day when the
 * process dies in between: the row exists and nothing was sent. So:
 *   claimed_at  the run that took this row, and when (the lease start)
 *   sent_at     NULL until the message reporting this row was delivered
 * A row with `sent_at` NULL and `claimed_at` older than the lease is taken again
 * (`attempts` + 1); a row with `sent_at` set is never touched again. The plan's
 * schema is a minimum; claimed_at, sent_at and attempts are the additions.
 */
export const goalReviews = agents.table(
  "goal_reviews",
  {
    goal_id: uuid("goal_id")
      .notNull()
      .references(() => goals.id),
    /** LOCAL date in APP_TIMEZONE, not UTC: 23:30 UTC is already tomorrow in Amsterdam. */
    review_date: date("review_date", { mode: "string" }).notNull(),
    /** NULL when the metric was unavailable (see `error`) or the goal was blocked. Never a stand-in 0. */
    value: numeric("value"),
    /** Built only from numbers, ids and counts: it feeds the "Plan next step" prompt. */
    evidence: text("evidence").notNull().default(""),
    /** ahead | on_track | behind | unknown — CHECK-constrained in the migration. */
    pace: text("pace").notNull().default("unknown"),
    error: text("error"),
    claimed_at: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
    sent_at: timestamp("sent_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(1),
  },
  (t) => ({
    pk: primaryKey({ name: "goal_reviews_pkey", columns: [t.goal_id, t.review_date] }),
    reviewDateIdx: index("goal_reviews_review_date_idx").on(t.review_date),
    paceCheck: check("goal_reviews_pace_check", sql`${t.pace} IN ('ahead', 'on_track', 'behind', 'unknown')`),
  }),
);

export type GoalRecord = typeof goals.$inferSelect;
export type GoalReviewRecord = typeof goalReviews.$inferSelect;
