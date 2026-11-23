/**
 * job_applications.mac_*: the Claude hand-off lane's lease and filled-tab state
 * ============================================================================
 * Same columns and same lease semantics as the Mac TS worker (mac-worker-queries.ts), so the two never open one row:
 * `leaseClaudeRows` is ONE statement, UPDATE ... WHERE id IN (SELECT ... LIMIT n FOR UPDATE SKIP LOCKED) AND no live
 * lease RETURNING *. Overlapping calls lock different rows (SKIP LOCKED) or, on the same row, the loser re-checks the
 * lease condition after the winner commits and gets nothing. Its reasons never match the TS worker's (CAPTCHA, bot
 * check), so the lanes are disjoint as well.
 */

import { and, asc, eq, gte, inArray, isNotNull, isNull, like, lt, ne, or, sql } from "drizzle-orm";
import { TENANT } from "../core/config.js";
import { MAC_MAX_ATTEMPTS, MAC_REASON_PATTERN, MAC_ROW_WINDOW_MS } from "../tools/jobhunt/mac-worker-rules.js";
import { CLAUDE_EXCLUDE_PATTERN, CLAUDE_FILLED_PREFIX, claudeFilledRows, claudeReasonSql, formatFilledResult, type ClaudeFilledRow, type FilledReport } from "../tools/jobhunt/claude-lane-rules.js";
import { normaliseCompanyName } from "../tools/jobhunt/sponsor-match.js";
import { getDb } from "./client.js";
import { cooledCompanies } from "./mac-worker-queries.js";
import { jobApplications, type JobApplication } from "./schema.js";

const noLiveLease = (now: Date) => or(isNull(jobApplications.mac_lease_until), lt(jobApplications.mac_lease_until, now));

/**
 * Lease up to `max` eligible Claude-lane rows under ONE lease id, oldest first. Eligible: a hand_off row whose reason is a
 * form Claude can fill (claude-lane-rules.ts), for a profile that is on, not applied, skipped or expired, no live lease,
 * attempts left, not in a cooled-down company. A stale "filled_to_submit" result from an earlier lapsed lease is cleared.
 */
export async function leaseClaudeRows(
  profileIds: readonly string[],
  opts: { readonly now: Date; readonly leaseId: string; readonly ttlMs: number; readonly max: number; readonly workday: boolean },
): Promise<JobApplication[]> {
  if (profileIds.length === 0 || opts.max < 1) return [];
  const { now } = opts;
  const db = getDb();
  const eligible = and(
    eq(jobApplications.tenant_id, TENANT),
    inArray(jobApplications.profile_id, [...profileIds]),
    eq(jobApplications.apply_lane, "hand_off"),
    sql`${jobApplications.apply_lane_reason} ~* ${claudeReasonSql(opts.workday)}`,
    sql`${jobApplications.apply_lane_reason} !~* ${MAC_REASON_PATTERN}`,
    // The exclusions read the cause after "<prefix>:", except Workday, whose own wording is not screened.
    sql`(${jobApplications.apply_lane_reason} ~* '^Workday:' OR regexp_replace(${jobApplications.apply_lane_reason}, '^[^:]*:\\s*', '') !~* ${CLAUDE_EXCLUDE_PATTERN})`,
    gte(jobApplications.apply_lane_at, new Date(now.getTime() - MAC_ROW_WINDOW_MS)),
    isNull(jobApplications.applied_at),
    isNull(jobApplications.skipped_at),
    ne(jobApplications.stage, "applied"),
    ne(jobApplications.liveness, "expired"),
    lt(jobApplications.mac_attempts, MAC_MAX_ATTEMPTS),
    noLiveLease(now),
  );
  const cooled = await cooledCompanies(profileIds, now);
  const candidates = await db
    .select({ id: jobApplications.id, company: jobApplications.company, profile: jobApplications.profile_id })
    .from(jobApplications)
    .where(eligible)
    .orderBy(asc(jobApplications.apply_lane_at))
    .limit(200);
  // One row per company per call: two tabs for one employer would trip the 30-day company cooldown on the second.
  const seen = new Set<string>();
  const allowed: string[] = [];
  for (const c of candidates) {
    const key = `${c.profile ?? ""}|${normaliseCompanyName(c.company)}`;
    if (cooled.get(c.profile ?? "")?.has(normaliseCompanyName(c.company)) || seen.has(key)) continue;
    seen.add(key);
    allowed.push(c.id);
  }
  if (allowed.length === 0) return [];
  const picked = db
    .select({ id: jobApplications.id })
    .from(jobApplications)
    .where(and(eligible, inArray(jobApplications.id, allowed)))
    .orderBy(asc(jobApplications.apply_lane_at))
    .limit(opts.max)
    .for("update", { skipLocked: true });
  return db
    .update(jobApplications)
    .set({
      mac_lease_id: opts.leaseId,
      mac_leased_at: now,
      mac_lease_until: new Date(now.getTime() + opts.ttlMs),
      mac_attempts: sql`${jobApplications.mac_attempts} + 1`,
      mac_result: sql`case when ${jobApplications.mac_result} like ${`${CLAUDE_FILLED_PREFIX}%`} then null else ${jobApplications.mac_result} end`,
    })
    .where(and(inArray(jobApplications.id, picked), noLiveLease(now)))
    .returning();
}

/**
 * Record a filled tab: the result becomes `filled_to_submit: {link, blanks}` and the lease is pushed out to `until` so
 * no lane opens the row while the founder decides. Never touches applied_at or the stage. False when `leaseId` lost the row.
 */
export async function markFilled(rowId: string, leaseId: string, report: FilledReport, until: Date, now: Date): Promise<boolean> {
  const rows = await getDb()
    .update(jobApplications)
    .set({ mac_lease_until: until, mac_result: formatFilledResult(report), mac_result_at: now })
    .where(and(eq(jobApplications.id, rowId), eq(jobApplications.mac_lease_id, leaseId), isNull(jobApplications.applied_at)))
    .returning({ id: jobApplications.id });
  return rows.length > 0;
}

/** Rows filled under one lease (one run), as the run's Telegram message lists them. */
export async function listFilledForLease(leaseId: string): Promise<ClaudeFilledRow[]> {
  const rows = await getDb()
    .select()
    .from(jobApplications)
    .where(and(eq(jobApplications.tenant_id, TENANT), eq(jobApplications.mac_lease_id, leaseId), like(jobApplications.mac_result, `${CLAUDE_FILLED_PREFIX}%`)));
  return claudeFilledRows(rows);
}

/** For the apply queue page: this profile's tabs Claude filled and the founder has not yet approved or failed. */
export async function listClaudeFilledRows(profileId: string): Promise<ClaudeFilledRow[]> {
  const rows = await getDb()
    .select()
    .from(jobApplications)
    .where(
      and(
        eq(jobApplications.tenant_id, TENANT),
        eq(jobApplications.profile_id, profileId),
        isNotNull(jobApplications.mac_lease_id),
        isNull(jobApplications.applied_at),
        isNull(jobApplications.skipped_at),
        like(jobApplications.mac_result, `${CLAUDE_FILLED_PREFIX}%`),
      ),
    );
  return claudeFilledRows(rows);
}
