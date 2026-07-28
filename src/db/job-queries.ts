/**
 * FounderOS — job_applications query functions
 * ============================================
 * The application state table behind the NL entry campaign
 * (docs/strategy/09-NL-ENTRY-CAMPAIGN.md §3). Its job is dedupe, stage tracking
 * and follow-up scheduling.
 *
 * Dedupe is enforced by the `ja_dedupe_uniq` constraint, not by a read-then-write
 * check here: a screen that races another screen must fail on the constraint
 * rather than quietly inserting a second row and letting the machine apply twice.
 *
 * Kept out of queries.ts, which is already over the LOC budget (mirrors
 * gap-scan-queries.ts and account-queries.ts).
 */

import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "./client.js";
import { jobApplications, type JobApplication, type NewJobApplication } from "./schema.js";

const DEFAULT_TENANT = "turicks";

/** Stages that represent a live application a human may still hear back from. */
export const LIVE_STAGES = ["drafted", "awaiting_approval", "applied", "replied"] as const;

/** Look up a previously screened role by its dedupe identity. */
export async function findApplicationByDedupeKey(
  dedupeKey: string,
  tenantId: string = DEFAULT_TENANT,
): Promise<JobApplication | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(jobApplications)
    .where(and(eq(jobApplications.tenant_id, tenantId), eq(jobApplications.dedupe_key, dedupeKey)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Record a screening verdict.
 *
 * Re-screening a role the machine has already seen UPDATES the verdict rather
 * than inserting: a posting that gains a salary figure on its second sighting
 * should upgrade from `flag` to `pass`, and `stage` must survive that update so a
 * role already applied to is never reset to `screened`.
 */
export async function recordScreenedApplication(
  row: NewJobApplication,
): Promise<JobApplication> {
  const db = getDb();
  const [saved] = await db
    .insert(jobApplications)
    .values(row)
    .onConflictDoUpdate({
      target: [jobApplications.tenant_id, jobApplications.dedupe_key],
      set: {
        company: row.company,
        registered_name: row.registered_name ?? null,
        title: row.title,
        url: row.url ?? null,
        sponsor_verdict: row.sponsor_verdict,
        salary_status: row.salary_status,
        salary_evidence: row.salary_evidence ?? null,
        fit_score: row.fit_score ?? null,
        fit_evidence: row.fit_evidence ?? null,
        notes: row.notes ?? null,
        updated_at: new Date(),
      },
    })
    .returning();

  if (!saved) throw new Error(`Failed to record screening for "${row.dedupe_key}".`);
  return saved;
}

/** Move an application to a new stage, stamping the contact clock. */
export async function updateApplicationStage(
  id: string,
  stage: string,
  opts: { appliedAt?: Date; lastContactAt?: Date; notes?: string } = {},
): Promise<JobApplication | null> {
  const db = getDb();
  const [saved] = await db
    .update(jobApplications)
    .set({
      stage,
      ...(opts.appliedAt ? { applied_at: opts.appliedAt } : {}),
      ...(opts.lastContactAt ? { last_contact_at: opts.lastContactAt } : {}),
      ...(opts.notes !== undefined ? { notes: opts.notes } : {}),
      updated_at: new Date(),
    })
    .where(eq(jobApplications.id, id))
    .returning();
  return saved ?? null;
}

/**
 * The Monday pipeline review: live applications, stalest contact first, so the
 * ones that have gone silent longest surface at the top.
 */
export async function listLiveApplications(
  opts: { limit?: number; tenantId?: string } = {},
): Promise<JobApplication[]> {
  const db = getDb();
  return db
    .select()
    .from(jobApplications)
    .where(
      and(
        eq(jobApplications.tenant_id, opts.tenantId ?? DEFAULT_TENANT),
        inArray(jobApplications.stage, [...LIVE_STAGES]),
      ),
    )
    .orderBy(asc(jobApplications.last_contact_at))
    .limit(opts.limit ?? 50);
}

/** Most recently screened roles, newest first — the daily-sweep read-back. */
export async function listRecentApplications(
  opts: { limit?: number; tenantId?: string } = {},
): Promise<JobApplication[]> {
  const db = getDb();
  return db
    .select()
    .from(jobApplications)
    .where(eq(jobApplications.tenant_id, opts.tenantId ?? DEFAULT_TENANT))
    .orderBy(desc(jobApplications.created_at))
    .limit(opts.limit ?? 20);
}
