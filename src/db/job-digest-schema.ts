/**
 * FounderOS - job_digest_state (Drizzle schema)
 * ============================================
 * Migration: drizzle/0044_job_digest_state.sql. Re-exported from src/db/schema.ts (one line) so
 * tests/unit/db/schema-migration-parity.test.ts sees the table. Own file and own pgSchema("agents") for the
 * same reasons as conversation-turns-schema.ts: schema.ts is far over the 400-line budget.
 *
 * One row per candidate: the new-role alerts the free sweep has found since the last batched message to the
 * jobs group, and when that message last went out. It is NOT a column on job_lane_heartbeats because the two
 * have opposite writers: the sweep rewrites the heartbeat 48 times a day, and one combined upsert would let
 * either clear the other field (the same reason fresh_viewed_at is written only by /fresh).
 */

import { jsonb, pgSchema, text, timestamp } from "drizzle-orm/pg-core";

const agents = pgSchema("agents");

/** One role waiting for the next batch. `key` is dedupeKey(company, title), the identity the database uses. */
export interface PendingAlertRow {
  readonly company: string;
  readonly title: string;
  readonly outcome: "pass" | "flag";
  readonly url: string | null;
  readonly key: string;
}

/** Everything buffered for one candidate. `overflow` counts roles past the cap, so none is dropped without a trace. */
export interface PendingAlerts {
  readonly rows: readonly PendingAlertRow[];
  readonly backfill: number;
  readonly overflow: number;
}

export const jobDigestState = agents.table("job_digest_state", {
  /** One row per candidate, the same key as job_lane_heartbeats. */
  profile_id: text("profile_id").primaryKey(),
  pending: jsonb("pending").$type<PendingAlerts | null>(),
  /** When the last batched message was sent. NULL until the first. */
  last_digest_at: timestamp("last_digest_at", { withTimezone: true }),
  updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type JobDigestStateRow = typeof jobDigestState.$inferSelect;
