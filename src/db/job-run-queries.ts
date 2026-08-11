/**
 * FounderOS — job_ingest_runs query functions
 * ===========================================
 * The cost ledger for the daily job sweep. One row per paid feed call.
 *
 * Kept out of job-queries.ts, which is already near the LOC budget and is about
 * application STATE — a different question from what the pipeline spends.
 *
 * A failed call gets a row too. The actor start is billed whether or not the run
 * returns anything, so a ledger that recorded only successes would under-report
 * exactly on the days something is wrong.
 */

import { and, desc, eq, gte, sql } from "drizzle-orm";
import { getDb } from "./client.js";
import { jobIngestRuns, type JobIngestRun, type NewJobIngestRun } from "./schema.js";

const DEFAULT_TENANT = "turicks";

/** Record one query's cost and yield. Never throws into the sweep. */
export async function recordIngestRun(row: NewJobIngestRun): Promise<JobIngestRun | null> {
  const db = getDb();
  const [saved] = await db.insert(jobIngestRuns).values(row).returning();
  return saved ?? null;
}

export interface SpendWindow {
  /** Paid feed calls in the window. */
  readonly runs: number;
  readonly returned: number;
  readonly screened: number;
  readonly passed: number;
  readonly costUsd: number;
  /** Calls that failed. Still billed a start, so still part of the cost. */
  readonly failed: number;
  /** Postings never seen before. `returned` is the bill; this is what it bought. */
  readonly fresh: number;
}

/**
 * What the pipeline has spent since `since`, and what that bought.
 *
 * The brief prints this. A cost line the founder never sees is a cost line
 * nobody governs — and the whole reason this table exists is that "what does
 * this cost" was a question about our own system we could not answer from data.
 */
export async function summariseSpend(
  since: Date,
  opts: { tenantId?: string } = {},
): Promise<SpendWindow> {
  const db = getDb();
  const [row] = await db
    .select({
      runs: sql<number>`count(*)`,
      returned: sql<number>`coalesce(sum(${jobIngestRuns.returned}), 0)`,
      screened: sql<number>`coalesce(sum(${jobIngestRuns.screened}), 0)`,
      passed: sql<number>`coalesce(sum(${jobIngestRuns.passed}), 0)`,
      cost: sql<string>`coalesce(sum(${jobIngestRuns.estimated_cost_usd}), 0)`,
      failed: sql<number>`count(*) filter (where ${jobIngestRuns.error} is not null)`,
      fresh: sql<number>`coalesce(sum(${jobIngestRuns.fresh}), 0)`,
    })
    .from(jobIngestRuns)
    .where(
      and(
        eq(jobIngestRuns.tenant_id, opts.tenantId ?? DEFAULT_TENANT),
        gte(jobIngestRuns.created_at, since),
      ),
    );

  return {
    runs: Number(row?.runs ?? 0),
    returned: Number(row?.returned ?? 0),
    screened: Number(row?.screened ?? 0),
    passed: Number(row?.passed ?? 0),
    costUsd: Number(row?.cost ?? 0),
    failed: Number(row?.failed ?? 0),
    fresh: Number(row?.fresh ?? 0),
  };
}

/** The most recent queries, newest first — the audit surface for a surprising bill. */
export async function listRecentIngestRuns(
  opts: { limit?: number; tenantId?: string } = {},
): Promise<JobIngestRun[]> {
  const db = getDb();
  return db
    .select()
    .from(jobIngestRuns)
    .where(eq(jobIngestRuns.tenant_id, opts.tenantId ?? DEFAULT_TENANT))
    .orderBy(desc(jobIngestRuns.created_at))
    .limit(opts.limit ?? 50);
}
