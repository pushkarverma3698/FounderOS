/**
 * Evolution Engine — the jobhunt sensor's database reader (plan part C1).
 * ========================================================================
 * The ONLY module in the jobhunt check that touches Postgres. It fetches and maps,
 * nothing else: every threshold and every judgement lives in the pure analyzer
 * (`analyzers/jobhunt.ts`), so the analyzer stays testable with array literals and
 * this file stays too thin to be wrong in an interesting way. Mapping rules live in
 * `jobhunt-rows.ts` and are unit tested; the SQL here was run against a real
 * Postgres with seeded rows (see the session note), because a unit test cannot say
 * whether a query is right.
 *
 * LOUD, NEVER PARTIAL. A read that fails throws, naming the table. A read that hit
 * READ_LIMIT throws too: counts computed from a truncated read would look like a
 * quiet platform, which is exactly the false silence this sensor exists to find.
 *
 * Imported dynamically by `jobhunt-check.ts`, like run-audit.ts's telemetry tier, so
 * a missing DATABASE_URL or a dead Postgres is a failure the check REPORTS.
 */

import { and, eq, gte, isNotNull, sql } from "drizzle-orm";
import { TENANT } from "../core/config.js";
import { getDb } from "../db/client.js";
import { jobApplications, jobIngestRuns, jobLaneHeartbeats } from "../db/schema.js";
import { FREE_INGEST_SOURCE } from "../tools/jobhunt/free-ingest.js";
import { listProfiles } from "../tools/jobhunt/profile-config.js";
import {
  ADAPTER_SILENT_BASELINE_DAYS,
  ADAPTER_SILENT_WINDOW_HOURS,
  CANDIDATE_NOT_ACTING_WINDOW_DAYS,
} from "./analyzers/jobhunt.js";
import type { JobhuntSnapshot } from "./analyzers/jobhunt.js";
import { FREE_LANE_FEED, toActivityRow, toHeartbeatRow, toIngestRunRow, toNewPostingRow } from "./jobhunt-rows.js";

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/**
 * Most rows any one read may return. Measured 2026-09-29: about 96 ledger rows a
 * day and a few hundred new postings a day, so this is two orders of magnitude of
 * headroom; hitting it means something is wrong, not that the market is busy.
 */
export const READ_LIMIT = 50_000;

/** The briefing sections that make a row actionable (plan C1: 28 do_today + 14 stretch + 20 ask = 62). */
const ACTIONABLE_SECTIONS = ["do_today", "stretch", "ask"] as const;

/** Run one read, naming the table in any failure, and refusing a truncated result. */
async function read<T>(table: string, query: () => Promise<T[]>): Promise<T[]> {
  let rows: T[];
  try {
    rows = await query();
  } catch (err) {
    throw new Error(`${table} read failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (rows.length > READ_LIMIT) {
    throw new Error(
      `${table} read hit the ${READ_LIMIT}-row limit: refusing to count from a partial read, which would look like a quiet platform`,
    );
  }
  return rows;
}

/** Everything the four jobhunt checks need, read at `now`. */
export async function collectJobhuntSnapshot(now: Date = new Date()): Promise<JobhuntSnapshot> {
  const db = getDb();
  const names = new Map(listProfiles().map((p) => [p.id, p.candidateName] as const));
  const runsSince = new Date(now.getTime() - ADAPTER_SILENT_WINDOW_HOURS * MS_PER_HOUR);
  const postingsSince = new Date(now.getTime() - ADAPTER_SILENT_WINDOW_HOURS * MS_PER_HOUR - ADAPTER_SILENT_BASELINE_DAYS * MS_PER_DAY);
  // Bound as an ISO string with an explicit cast: postgres.js rejects a bare Date inside a raw sql template.
  const activitySince = new Date(now.getTime() - CANDIDATE_NOT_ACTING_WINDOW_DAYS * MS_PER_DAY).toISOString();

  const [runs, heartbeats, postings, activity] = await Promise.all([
    read("job_ingest_runs", () =>
      db
        .select({ createdAt: jobIngestRuns.created_at, error: jobIngestRuns.error })
        .from(jobIngestRuns)
        .where(
          and(
            eq(jobIngestRuns.tenant_id, TENANT),
            eq(jobIngestRuns.feed, FREE_LANE_FEED),
            gte(jobIngestRuns.created_at, runsSince),
          ),
        )
        .limit(READ_LIMIT + 1),
    ),
    read("job_lane_heartbeats", () =>
      db
        .select({
          profileId: jobLaneHeartbeats.profile_id,
          zeroPassStreak: jobLaneHeartbeats.zero_pass_streak,
          lastFunnel: jobLaneHeartbeats.last_funnel,
        })
        .from(jobLaneHeartbeats)
        .limit(READ_LIMIT + 1),
    ),
    // Postings the free lane stored for the first time. `created_at` is when it first saw them, which is
    // what "new" means; `posted_at` is when the employer published, which is not.
    read("job_applications (new postings)", () =>
      db
        .select({
          createdAt: jobApplications.created_at,
          company: jobApplications.company,
          title: jobApplications.title,
          url: jobApplications.url,
        })
        .from(jobApplications)
        .where(
          and(
            eq(jobApplications.tenant_id, TENANT),
            eq(jobApplications.source, FREE_INGEST_SOURCE),
            isNotNull(jobApplications.url),
            gte(jobApplications.created_at, postingsSince),
          ),
        )
        .limit(READ_LIMIT + 1),
    ),
    // One row per candidate. `brief_section` is the last brief's numbering, so a row counts as actionable
    // while it is still on the list a candidate is shown; applied/skipped are the founder's own clicks.
    read("job_applications (apply activity)", () =>
      db
        .select({
          profileId: jobApplications.profile_id,
          doToday: sql<string>`count(*) filter (where ${jobApplications.brief_section} = ${ACTIONABLE_SECTIONS[0]} and ${jobApplications.created_at} >= ${activitySince}::timestamptz)`,
          stretch: sql<string>`count(*) filter (where ${jobApplications.brief_section} = ${ACTIONABLE_SECTIONS[1]} and ${jobApplications.created_at} >= ${activitySince}::timestamptz)`,
          ask: sql<string>`count(*) filter (where ${jobApplications.brief_section} = ${ACTIONABLE_SECTIONS[2]} and ${jobApplications.created_at} >= ${activitySince}::timestamptz)`,
          applied: sql<string>`count(*) filter (where ${jobApplications.applied_at} >= ${activitySince}::timestamptz)`,
          skipped: sql<string>`count(*) filter (where ${jobApplications.skipped_at} >= ${activitySince}::timestamptz)`,
        })
        .from(jobApplications)
        .where(eq(jobApplications.tenant_id, TENANT))
        .groupBy(jobApplications.profile_id),
    ),
  ]);

  return {
    ingestRuns: runs.flatMap((r) => toIngestRunRow(r) ?? []),
    laneHeartbeats: heartbeats.map((h) => toHeartbeatRow(h, names)),
    newPostings: postings.flatMap((p) => toNewPostingRow(p) ?? []),
    applyActivity: activity.map((a) => toActivityRow(a, names)),
  };
}
