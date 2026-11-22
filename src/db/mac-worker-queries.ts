/**
 * job_applications.mac_*: the Mac worker's lease (migration 0048)
 * ===============================================================
 * `leaseNextRow` is one statement: UPDATE ... WHERE id = (SELECT ... LIMIT 1 FOR UPDATE SKIP LOCKED) AND no live lease
 * RETURNING *. Two overlapping calls lock different rows (SKIP LOCKED) or, on the same row, the loser re-checks the
 * lease condition after the winner commits and gets nothing, so no row is ever returned twice.
 */

import { and, asc, eq, gte, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { TENANT } from "../core/config.js";
import { MAC_MAX_ATTEMPTS, MAC_REASON_PATTERN, MAC_ROW_WINDOW_MS } from "../tools/jobhunt/mac-worker-rules.js";
import { getDb } from "./client.js";
import { jobApplications, macWorkerBeat, type JobApplication } from "./schema.js";

const WORKER_ID = "mac";

const noLiveLease = (now: Date) => or(isNull(jobApplications.mac_lease_until), lt(jobApplications.mac_lease_until, now));

/**
 * Lease the oldest eligible row: a hand_off row whose reason names a CAPTCHA or bot check, for a profile that is on
 * (`profileIds`), not applied, skipped or expired, with no live lease and attempts left. Null when nothing is eligible.
 */
export async function leaseNextRow(
  profileIds: readonly string[],
  now: Date,
  leaseId: string,
  ttlMs: number,
): Promise<JobApplication | null> {
  if (profileIds.length === 0) return null;
  const db = getDb();
  const candidate = db
    .select({ id: jobApplications.id })
    .from(jobApplications)
    .where(
      and(
        eq(jobApplications.tenant_id, TENANT),
        inArray(jobApplications.profile_id, [...profileIds]),
        eq(jobApplications.apply_lane, "hand_off"),
        sql`${jobApplications.apply_lane_reason} ~* ${MAC_REASON_PATTERN}`,
        gte(jobApplications.apply_lane_at, new Date(now.getTime() - MAC_ROW_WINDOW_MS)),
        isNull(jobApplications.applied_at),
        isNull(jobApplications.skipped_at),
        ne(jobApplications.stage, "applied"),
        ne(jobApplications.liveness, "expired"),
        lt(jobApplications.mac_attempts, MAC_MAX_ATTEMPTS),
        noLiveLease(now),
      ),
    )
    .orderBy(asc(jobApplications.apply_lane_at))
    .limit(1)
    .for("update", { skipLocked: true });
  const rows = await db
    .update(jobApplications)
    .set({
      mac_lease_id: leaseId,
      mac_leased_at: now,
      mac_lease_until: new Date(now.getTime() + ttlMs),
      mac_attempts: sql`${jobApplications.mac_attempts} + 1`,
    })
    .where(and(inArray(jobApplications.id, candidate), noLiveLease(now)))
    .returning();
  return rows[0] ?? null;
}

/** The row, only while `leaseId` is the lease on it (live or lapsed but not yet re-leased or released). */
export async function getLeasedRow(rowId: string, leaseId: string): Promise<JobApplication | null> {
  const rows = await getDb()
    .select()
    .from(jobApplications)
    .where(and(eq(jobApplications.id, rowId), eq(jobApplications.tenant_id, TENANT), eq(jobApplications.mac_lease_id, leaseId)))
    .limit(1);
  return rows[0] ?? null;
}

/** Push the lease out to `until` and note why (challenge, code_needed). False when `leaseId` no longer holds the row. */
export async function extendLease(rowId: string, leaseId: string, until: Date, result: string, now: Date): Promise<boolean> {
  const rows = await getDb()
    .update(jobApplications)
    .set({ mac_lease_until: until, mac_result: result, mac_result_at: now })
    .where(and(eq(jobApplications.id, rowId), eq(jobApplications.mac_lease_id, leaseId)))
    .returning({ id: jobApplications.id });
  return rows.length > 0;
}

/** End the lease and record the outcome (failed:<reason>, confirmed). False when `leaseId` no longer holds the row. */
export async function releaseLease(rowId: string, leaseId: string, result: string, now: Date): Promise<boolean> {
  const rows = await getDb()
    .update(jobApplications)
    .set({ mac_lease_id: null, mac_leased_at: null, mac_lease_until: null, mac_result: result, mac_result_at: now })
    .where(and(eq(jobApplications.id, rowId), eq(jobApplications.mac_lease_id, leaseId)))
    .returning({ id: jobApplications.id });
  return rows.length > 0;
}

export async function recordMacBeat(now: Date): Promise<void> {
  await getDb()
    .insert(macWorkerBeat)
    .values({ worker_id: WORKER_ID, last_beat_at: now })
    .onConflictDoUpdate({ target: macWorkerBeat.worker_id, set: { last_beat_at: now } });
}

/** When the Mac last checked in, or null if it never has. The queue and digest read this with `macOnline`. */
export async function getLastMacBeat(): Promise<Date | null> {
  const rows = await getDb().select({ at: macWorkerBeat.last_beat_at }).from(macWorkerBeat).where(eq(macWorkerBeat.worker_id, WORKER_ID)).limit(1);
  return rows[0]?.at ?? null;
}
