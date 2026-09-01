/**
 * FounderOS — the apply queue
 * ===========================
 * Reads for the Google Sheet and the Mac apply client, and the two writes that
 * record what the founder actually did.
 *
 * THERE IS NO SECOND NOTION OF MEMBERSHIP HERE. The queue is defined by
 * `brief_section`, which `persistBriefRanks` writes from `brief-select.ts` —
 * the single place that decides which rows are actionable. Re-deciding it in
 * SQL would create a second answer to "is this row worth applying to", and the
 * two would drift the first time a cap or a gate changed. The cost is that the
 * queue is only as fresh as the last ranking; the sweep runs a ranking before
 * every export, so that is once per sweep.
 *
 * Kept out of job-queries.ts, which is at 369 of the 400-line budget (same
 * reason job-queries.ts was split out of queries.ts).
 */

import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb } from "./client.js";
import { jobApplications, type JobApplication } from "./schema.js";

const DEFAULT_TENANT = "turicks";

/**
 * The sections whose rows are worth an application.
 *
 * `ask` is deliberately absent. Those rows have an unresolved gate and their
 * action is a question, not a submission — putting them in the apply queue
 * would hand the founder a pre-filled form for a role whose blocking doubt
 * nobody has answered yet.
 *
 * `standing` (added 2026-09-01) IS present: those rows cleared the identical
 * bar `do_today` did — pass, re-confirmed live — and are older than the fresh
 * window for no reason that bears on whether to apply. Leaving it out here
 * would repeat the exact reach bug this section's own module comment warns
 * against: a second, SQL-side notion of "actionable" that silently disagrees
 * with brief-select.ts the moment a new section is added to one and not the
 * other. `mac-client/mac_client/sync.py`'s QUEUE_SQL reads this same list.
 */
export const APPLYABLE_SECTIONS = ["do_today", "stretch", "standing"] as const;

/** How many screened rows the Log tab carries. Enough to audit, bounded so the write stays one call. */
export const LOG_TAB_ROWS = 500;

/**
 * Rows the founder has not yet acted on, best first.
 *
 * `applied_at IS NULL AND skipped_at IS NULL` is the whole definition of "still
 * in the queue" — see the columns' comment in schema.ts for why those are two
 * facts rather than one status.
 */
export async function listApplyQueue(tenantId: string = DEFAULT_TENANT): Promise<JobApplication[]> {
  const db = getDb();
  return db
    .select()
    .from(jobApplications)
    .where(
      and(
        eq(jobApplications.tenant_id, tenantId),
        inArray(jobApplications.brief_section, [...APPLYABLE_SECTIONS]),
        isNull(jobApplications.applied_at),
        isNull(jobApplications.skipped_at),
      ),
    )
    .orderBy(asc(jobApplications.brief_rank));
}

/**
 * The audit trail: everything screened recently, rejects included.
 *
 * Rejects are the point. A row that was screened and thrown away is the only
 * evidence that the filters are aimed correctly, and a Sheet that showed only
 * the winners would make an over-tight gate indistinguishable from a quiet
 * market — the ambiguity that already cost this pipeline weeks.
 */
export async function listRecentlyScreened(
  tenantId: string = DEFAULT_TENANT,
  limit: number = LOG_TAB_ROWS,
): Promise<JobApplication[]> {
  const db = getDb();
  return db
    .select()
    .from(jobApplications)
    .where(eq(jobApplications.tenant_id, tenantId))
    .orderBy(desc(jobApplications.created_at))
    .limit(limit);
}

/**
 * Record that the founder submitted, or passed on, these rows.
 *
 * Idempotent by `IS NULL` guard rather than by blind overwrite: the Mac client
 * retries its flow-back after a failed push, and a retry must not move a
 * timestamp the founder set an hour ago. Returns how many rows actually
 * changed, so a push that matched nothing is visible as such instead of
 * reporting success for work it did not do.
 */
export async function markApplied(
  ids: readonly string[],
  tenantId: string = DEFAULT_TENANT,
): Promise<number> {
  return stampQueueRows(ids, tenantId, "applied");
}

export async function markSkipped(
  ids: readonly string[],
  tenantId: string = DEFAULT_TENANT,
): Promise<number> {
  return stampQueueRows(ids, tenantId, "skipped");
}

async function stampQueueRows(
  ids: readonly string[],
  tenantId: string,
  outcome: "applied" | "skipped",
): Promise<number> {
  if (ids.length === 0) return 0;
  const db = getDb();
  const column = outcome === "applied" ? jobApplications.applied_at : jobApplications.skipped_at;
  const updated = await db
    .update(jobApplications)
    .set({
      ...(outcome === "applied" ? { applied_at: new Date() } : { skipped_at: new Date() }),
      // `stage` tracks the human-visible funnel and must follow an application.
      // A skip leaves it alone: the row was never in the funnel.
      ...(outcome === "applied" ? { stage: "applied" as const } : {}),
      updated_at: new Date(),
    })
    .where(
      and(
        eq(jobApplications.tenant_id, tenantId),
        inArray(jobApplications.id, [...ids]),
        isNull(column),
      ),
    )
    .returning({ id: jobApplications.id });
  return updated.length;
}

/** How many rows the founder has applied to, ever — the number the pipeline exists to move. */
export async function countApplied(tenantId: string = DEFAULT_TENANT): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(jobApplications)
    .where(
      and(eq(jobApplications.tenant_id, tenantId), sql`${jobApplications.applied_at} IS NOT NULL`),
    );
  return row?.n ?? 0;
}
