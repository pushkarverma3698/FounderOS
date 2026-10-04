/**
 * The weekly-application target for a candidate, read from the open
 * `applications_7d:<profile>` goal. Lives in the gateway because the tool layer
 * that renders the brief may not import src/goals.
 */
import { childLogger } from "../infra/logger.js";
import { getProfile } from "../tools/jobhunt/profile-config.js";

const log = childLogger({ module: "gateway:jobhunt-goal" });

export async function weeklyApplicationGoal(profileId: string): Promise<number | null> {
  try {
    const { createPgGoalRepo } = await import("../goals/pg-repo.js");
    const goals = await createPgGoalRepo().listOpenGoals(getProfile().tenantId);
    const goal = goals.find((g) => g.metric_key === "applications_7d" && g.metric_arg === profileId);
    return goal ? goal.target : null;
  } catch (err) {
    // allow-failopen: the goal is decoration on the progress line; no goal reads as none set.
    log.warn({ err }, "Weekly application goal unavailable");
    return null;
  }
}
