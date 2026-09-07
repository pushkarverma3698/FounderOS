/**
 * FounderOS — free-lane heartbeat persistence
 * ============================================
 * Split out of job-queries.ts (already over the LOC budget) rather than added
 * to it. Backs the per-profile state sweep-heartbeat.ts's pure functions
 * decide over — see job_lane_heartbeats in schema.ts for why this exists as a
 * table rather than the in-process Map it replaced.
 */

import { eq } from "drizzle-orm";
import { getDb } from "./client.js";
import { jobLaneHeartbeats, type JobLaneHeartbeat } from "./schema.js";
import type { HeartbeatState } from "../tools/jobhunt/sweep-heartbeat.js";

function toState(row: JobLaneHeartbeat): HeartbeatState {
  return {
    quietSweeps: row.quiet_sweeps,
    boardsPolled: row.boards_polled,
    lastMessageAt: row.last_message_at.getTime(),
    zeroPassStreak: row.zero_pass_streak,
    lastFunnel: (row.last_funnel as HeartbeatState["lastFunnel"]) ?? null,
  };
}

/** Null when this profile has never had a row — caller falls back to `initialHeartbeat(now)`. */
export async function loadLaneHeartbeat(profileId: string): Promise<HeartbeatState | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(jobLaneHeartbeats)
    .where(eq(jobLaneHeartbeats.profile_id, profileId))
    .limit(1);
  return row ? toState(row) : null;
}

/** Upsert — one row per profile, always the latest state. */
export async function saveLaneHeartbeat(profileId: string, state: HeartbeatState): Promise<void> {
  const db = getDb();
  await db
    .insert(jobLaneHeartbeats)
    .values({
      profile_id: profileId,
      quiet_sweeps: state.quietSweeps,
      boards_polled: state.boardsPolled,
      last_message_at: new Date(state.lastMessageAt),
      zero_pass_streak: state.zeroPassStreak,
      // FreeFunnel is a closed interface (named numeric fields); the jsonb
      // column's $type is the open Record<string, number | null> shape every
      // caller of this table can share. Every FreeFunnel value is a plain
      // number, so this is a safe widening, not an unsafe cast.
      last_funnel: state.lastFunnel as Record<string, number | null> | null,
      updated_at: new Date(),
    })
    .onConflictDoUpdate({
      target: jobLaneHeartbeats.profile_id,
      set: {
        quiet_sweeps: state.quietSweeps,
        boards_polled: state.boardsPolled,
        last_message_at: new Date(state.lastMessageAt),
        zero_pass_streak: state.zeroPassStreak,
        last_funnel: state.lastFunnel as Record<string, number | null> | null,
        updated_at: new Date(),
      },
    });
}

/** Test/ops seam: wipe every profile's heartbeat state. */
export async function clearLaneHeartbeats(): Promise<void> {
  const db = getDb();
  await db.delete(jobLaneHeartbeats);
}
