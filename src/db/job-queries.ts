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

import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
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
 * Roles whose title WORDS match an already-screened role at the same company,
 * excluding the exact key itself.
 *
 * This exists to catch the re-post: "Senior AI Engineer" and "AI Engineer
 * (Senior)" are one job with two spellings, and the exact-key constraint sees
 * two. It returns candidates for a human warning rather than blocking, because
 * token-set equality is not sound enough to forfeit an application on.
 */
export async function findApplicationsBySoftKey(
  softKey: string,
  excludeDedupeKey: string,
  tenantId: string = DEFAULT_TENANT,
): Promise<JobApplication[]> {
  const db = getDb();
  return db
    .select()
    .from(jobApplications)
    .where(
      and(
        eq(jobApplications.tenant_id, tenantId),
        eq(jobApplications.soft_dedupe_key, softKey),
        ne(jobApplications.dedupe_key, excludeDedupeKey),
      ),
    )
    .limit(5);
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
        soft_dedupe_key: row.soft_dedupe_key ?? null,
        route: row.route ?? "hsm",
        track: row.track ?? "unclassified",
        external_id: row.external_id ?? null,
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

/**
 * Screening outcomes for review, newest first, optionally filtered by verdict.
 *
 * The audit surface for the gates themselves. A stale register or a broken regex
 * shows up as a reject rate that jumps, and without a way to read rejects back
 * there is nothing anywhere that would reveal it.
 */
export async function listScreenedApplications(
  opts: { verdict?: string; route?: string; limit?: number; tenantId?: string } = {},
): Promise<JobApplication[]> {
  const db = getDb();
  const conditions = [eq(jobApplications.tenant_id, opts.tenantId ?? DEFAULT_TENANT)];
  if (opts.verdict) conditions.push(eq(jobApplications.salary_status, opts.verdict));
  if (opts.route) conditions.push(eq(jobApplications.route, opts.route));

  return db
    .select()
    .from(jobApplications)
    .where(and(...conditions))
    .orderBy(desc(jobApplications.created_at))
    .limit(opts.limit ?? 25);
}

/**
 * How many postings cleared every gate — the denominator for the CV gap report.
 *
 * Reported next to every percentage, because "68% of postings" over 4 postings
 * and over 400 are the same number and mean entirely different things. Without
 * the sample size the report invites a CV rewrite on three data points.
 */
export async function countPassingApplications(
  opts: { track?: string; tenantId?: string } = {},
): Promise<number> {
  const db = getDb();
  const conditions = [
    eq(jobApplications.tenant_id, opts.tenantId ?? DEFAULT_TENANT),
    eq(jobApplications.salary_status, "pass"),
  ];
  // The denominator must match the numerator's population. A per-track gap
  // report divided by the all-track count understates every percentage.
  if (opts.track) conditions.push(eq(jobApplications.track, opts.track));

  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(jobApplications)
    .where(and(...conditions));
  return Number(row?.n ?? 0);
}

/**
 * Screened-but-not-yet-engaged rows — the population the daily brief ranks.
 *
 * Restricted to `stage = 'screened'` so a role already drafted or applied to
 * never reappears in DO TODAY, and ordered newest-first so a capped read takes
 * the freshest postings rather than an arbitrary slice.
 */
export async function listActionableApplications(
  opts: { verdicts?: readonly string[]; limit?: number; tenantId?: string } = {},
): Promise<JobApplication[]> {
  const db = getDb();
  return db
    .select()
    .from(jobApplications)
    .where(
      and(
        eq(jobApplications.tenant_id, opts.tenantId ?? DEFAULT_TENANT),
        eq(jobApplications.stage, "screened"),
        inArray(jobApplications.salary_status, [...(opts.verdicts ?? ["pass", "flag"])]),
      ),
    )
    .orderBy(desc(jobApplications.created_at))
    .limit(opts.limit ?? 100);
}

/**
 * Record a liveness result.
 *
 * `expired` moves the row out of the actionable pool AND writes the reason, so
 * a posting that vanishes from the brief can always be explained. Nothing is
 * silently dropped — an unexplained disappearance is indistinguishable from a
 * bug in the ranking.
 */
export async function recordLiveness(
  id: string,
  liveness: "live" | "expired" | "unverifiable",
  opts: { reason?: string; checkedAt?: Date } = {},
): Promise<JobApplication | null> {
  const db = getDb();
  const [saved] = await db
    .update(jobApplications)
    .set({
      liveness,
      liveness_checked_at: opts.checkedAt ?? new Date(),
      ...(liveness === "expired" ? { stage: "expired" } : {}),
      ...(opts.reason ? { notes: opts.reason } : {}),
      updated_at: new Date(),
    })
    .where(eq(jobApplications.id, id))
    .returning();
  return saved ?? null;
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
