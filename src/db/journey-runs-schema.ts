/**
 * FounderOS - journey_runs (Drizzle schema)
 * =========================================
 * Migration: drizzle/0046_journey_runs.sql. Re-exported from src/db/schema.ts (one line) so
 * tests/unit/db/schema-migration-parity.test.ts sees the table. Own file and own pgSchema("agents") for the
 * same reasons as conversation-turns-schema.ts: schema.ts is far over the 400-line budget.
 *
 * One row per journey per morning run (scripts/journey-daily.ts, AG-051): J1-J5 and the A-C results. The trend
 * ("J2 has been red for 4 mornings") is a query over this table; the morning message itself is built from the run.
 */

import { boolean, index, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

const agents = pgSchema("agents");

export const journeyRuns = agents.table(
  "journey_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: text("tenant_id").notNull(),
    /** Every row written by one morning run shares this id. */
    run_id: text("run_id").notNull(),
    /** J1..J5, A, B, C. */
    journey: text("journey").notNull(),
    /** green | red | not_built. */
    status: text("status").notNull(),
    /** Health line verdict for the run (the same on every row of one run). */
    health_ok: boolean("health_ok").notNull(),
    /** The reason printed in the morning message, real numbers included. */
    detail: text("detail").notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("journey_runs_journey_created_idx").on(t.journey, t.created_at)],
);

export type JourneyRunRow = typeof journeyRuns.$inferSelect;
