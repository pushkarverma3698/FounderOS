/**
 * job_applications: shadow apply lane reads and writes (kept out of job-queries.ts, over its line budget).
 */

import { and, asc, eq, gte, inArray, isNotNull, isNull, like, lt, ne, not, or } from "drizzle-orm";
import { getDb } from "./client.js";
import { jobApplications, type JobApplication } from "./schema.js";

const WINDOW_MS = 24 * 60 * 60 * 1000;
const CANDIDATE_LIMIT = 200;

/**
 * Coarse SQL cut of the shadow-apply pool, oldest first. It drops rows with a flag or reject gate here, so rows
 * that can never be routed do not fill the limit and starve the ones that can. `isShadowCandidate` is the exact rule applied on top. */
export async function listLaneCandidates(profileId: string, now: Date): Promise<JobApplication[]> {
  const cutoff = new Date(now.getTime() - WINDOW_MS);
  return getDb()
    .select()
    .from(jobApplications)
    .where(
      and(
        eq(jobApplications.profile_id, profileId),
        gte(jobApplications.created_at, cutoff),
        isNotNull(jobApplications.gate_json),
        not(like(jobApplications.gate_json, '%"status":"flag"%')),
        not(like(jobApplications.gate_json, '%"status":"reject"%')),
        isNull(jobApplications.applied_at),
        isNull(jobApplications.skipped_at),
        ne(jobApplications.liveness, "expired"),
        or(isNull(jobApplications.apply_lane_at), lt(jobApplications.apply_lane_at, cutoff)),
      ),
    )
    .orderBy(asc(jobApplications.created_at))
    .limit(CANDIDATE_LIMIT);
}

/**
 * Claim a row before its form is opened: stamps `apply_lane_at` only while no stamp from the last 24h
 * exists, so two overlapping runs cannot open the same form. True when this caller won.
 */
export async function claimLaneRow(id: string, now: Date): Promise<boolean> {
  const cutoff = new Date(now.getTime() - WINDOW_MS);
  const claimed = await getDb()
    .update(jobApplications)
    .set({ apply_lane_at: now })
    .where(and(eq(jobApplications.id, id), or(isNull(jobApplications.apply_lane_at), lt(jobApplications.apply_lane_at, cutoff))))
    .returning({ id: jobApplications.id });
  return claimed.length > 0;
}

export async function recordLane(id: string, lane: string, reason: string, now: Date): Promise<void> {
  await getDb()
    .update(jobApplications)
    .set({ apply_lane: lane, apply_lane_reason: reason, apply_lane_at: now })
    .where(eq(jobApplications.id, id));
}

/** Store the ATS fit + tailoring result. Written once per row; its presence is the "already tried" marker. */
export async function recordAts(id: string, atsJson: string): Promise<void> {
  await getDb().update(jobApplications).set({ ats_json: atsJson }).where(eq(jobApplications.id, id));
}

export interface LaneReasonRow {
  readonly id: string;
  readonly company: string;
  readonly reason: string;
}

/** Open rows the shadow pass sent to needs_you since `since`, with the reason that names the unanswered questions. */
export async function listNeedsYouReasons(profileId: string, since: Date): Promise<LaneReasonRow[]> {
  const rows = await getDb()
    .select({ id: jobApplications.id, company: jobApplications.company, reason: jobApplications.apply_lane_reason })
    .from(jobApplications)
    .where(
      and(
        eq(jobApplications.profile_id, profileId),
        eq(jobApplications.apply_lane, "needs_you"),
        gte(jobApplications.apply_lane_at, since),
        isNull(jobApplications.applied_at),
        isNull(jobApplications.skipped_at),
        ne(jobApplications.liveness, "expired"),
      ),
    );
  return rows.flatMap((r) => (r.reason ? [{ id: r.id, company: r.company, reason: r.reason }] : []));
}

/** Roles the shadow pass routed to a person in the last 24h that are still open: the evening batch's list. */
export async function listWaitingLaneRows(profileId: string, now: Date): Promise<JobApplication[]> {
  const cutoff = new Date(now.getTime() - WINDOW_MS);
  return getDb()
    .select()
    .from(jobApplications)
    .where(
      and(
        eq(jobApplications.profile_id, profileId),
        inArray(jobApplications.apply_lane, ["needs_you", "hand_off"]),
        gte(jobApplications.apply_lane_at, cutoff),
        isNull(jobApplications.applied_at),
        isNull(jobApplications.skipped_at),
      ),
    )
    .orderBy(asc(jobApplications.apply_lane_at));
}
