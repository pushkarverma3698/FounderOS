/**
 * The reads behind the daily apply scoreboard (src/tools/jobhunt/apply-scoreboard.ts): rows first seen in the
 * window, the open waiting lanes, and the auto-send and submit audit rows written in the window. Reads only.
 */

import { and, eq, gte, lt, sql } from "drizzle-orm";
import { getDb } from "./client.js";
import { ATTEMPT_ACTION, RESULT_ACTION } from "./job-auto-send-queries.js";
import { listWaitingLaneRows } from "./job-apply-lane-queries.js";
import { actionLog, jobApplications } from "./schema.js";
import type { ScoreboardInput } from "../tools/jobhunt/apply-scoreboard.js";

const SUBMITTED_ACTION = "job_application_submitted";

export async function loadScoreboardInput(profileId: string, start: Date, end: Date, now: Date): Promise<ScoreboardInput> {
  const db = getDb();
  const caught = await db
    .select({ created_at: jobApplications.created_at, apply_lane: jobApplications.apply_lane, apply_lane_at: jobApplications.apply_lane_at })
    .from(jobApplications)
    .where(and(eq(jobApplications.profile_id, profileId), gte(jobApplications.created_at, start), lt(jobApplications.created_at, end)));
  const logRows = (action: string) =>
    db
      .select({ payload: actionLog.payload })
      .from(actionLog)
      .where(and(eq(actionLog.action, action), sql`${actionLog.payload}->>'profileId' = ${profileId}`, gte(actionLog.created_at, start), lt(actionLog.created_at, end)));
  const [attempts, submitted, results, waiting] = await Promise.all([
    logRows(ATTEMPT_ACTION),
    logRows(SUBMITTED_ACTION),
    logRows(RESULT_ACTION),
    listWaitingLaneRows(profileId, now),
  ]);
  const p = (r: { payload: unknown }) => (r.payload ?? {}) as { via?: string; result?: string; detail?: string };
  return {
    caught,
    waitingLanes: waiting.map((w) => w.apply_lane),
    attempts: attempts.length,
    submitted: submitted.map((r) => ({ via: p(r).via ?? null })),
    results: results.map((r) => ({ result: p(r).result ?? "unknown", detail: p(r).detail ?? "" })),
  };
}
