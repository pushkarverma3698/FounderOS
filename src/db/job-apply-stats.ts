/**
 * FounderOS - the numbers behind the digest's "apply" nudge
 * ========================================================
 * Two counts per candidate, read fresh from job_applications on every batch: roles applied to in the last
 * 7 days, and roles still open in today's do-now list. Reads only.
 */

import { and, eq, gte, isNull, sql } from "drizzle-orm";
import { getDb } from "./client.js";
import { jobApplications } from "./schema.js";

export const NUDGE_WINDOW_DAYS = 7;

export async function applyStatsFor(
  profileId: string,
  tenantId: string,
  now: Date,
): Promise<{ appliedWeek: number; openDoToday: number }> {
  const db = getDb();
  const since = new Date(now.getTime() - NUDGE_WINDOW_DAYS * 24 * 3_600_000);
  const own = and(eq(jobApplications.tenant_id, tenantId), eq(jobApplications.profile_id, profileId));
  const [applied] = await db
    .select({ n: sql<number>`count(*)` })
    .from(jobApplications)
    .where(and(own, gte(jobApplications.applied_at, since)));
  const [open] = await db
    .select({ n: sql<number>`count(*)` })
    .from(jobApplications)
    .where(
      and(
        own,
        eq(jobApplications.brief_section, "do_today"),
        isNull(jobApplications.applied_at),
        isNull(jobApplications.skipped_at),
      ),
    );
  return { appliedWeek: Number(applied?.n ?? 0), openDoToday: Number(open?.n ?? 0) };
}
