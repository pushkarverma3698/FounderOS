/**
 * The brief's "progress, not guilt" line (telegram UX audit P2-1).
 *
 * Replaces "N roles sat undrafted for up to M days" with this week's real count,
 * measured against the founder's own `/goal` for applications when one exists.
 * Counting is a database read; a failure yields `undefined`, and the brief falls
 * back to the old line rather than printing a made-up zero.
 */
import { and, eq, gte, sql } from "drizzle-orm";
import { getDb } from "../../db/client.js";
import { jobApplications } from "../../db/schema.js";
import { childLogger } from "../../infra/logger.js";
import { getProfile, type JobSearchProfile } from "./profile-config.js";

const log = childLogger({ module: "jobhunt:brief-progress" });

export interface WeekProgress {
  readonly applied: number;
  /** Target of the open `applications_7d` goal for this profile, or null when none is set. */
  readonly goal: number | null;
}

export function renderProgress(p: WeekProgress): string {
  const goal = p.goal === null ? "" : ` · goal ${p.goal}`;
  return `<b>📈 This week: ${p.applied} applied${goal}</b>`;
}

/**
 * `goal` is passed in by the gateway: model-reachable code may not import src/goals
 * (tests/unit/goals/no-llm-goal-tools.test.ts), so the tool layer never reads goals itself.
 */
export async function loadWeekProgress(
  profile: JobSearchProfile,
  now: Date,
  goal: number | null = null,
): Promise<WeekProgress | undefined> {
  try {
    const since = new Date(now.getTime() - 7 * 86_400_000);
    const [row] = await getDb()
      .select({ n: sql<number>`count(*)::int` })
      .from(jobApplications)
      .where(
        and(
          eq(jobApplications.tenant_id, getProfile().tenantId),
          eq(jobApplications.profile_id, profile.id),
          gte(jobApplications.applied_at, since),
        ),
      );
    return { applied: row?.n ?? 0, goal };
  } catch (err) {
    // allow-failopen: the progress line is decoration; the brief falls back to the undrafted line.
    log.warn({ err }, "Week progress unavailable");
    return undefined;
  }
}
