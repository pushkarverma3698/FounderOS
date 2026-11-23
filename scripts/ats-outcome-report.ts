/**
 * ATS score band vs outcome for sent applications (READ ONLY)
 * ===========================================================
 * Data for choosing APPLY_ATS_MIN_OVERLAP. Selects sent rows (applied_at set) and prints counts per pre-tailoring
 * ATS band (<40, 40-60, 60-80, 80+) against reply / interview / reject / none. Changes no threshold, writes nothing.
 *
 *   node --import tsx/esm --env-file=.env scripts/ats-outcome-report.ts [--profile <id>]
 */

import { and, eq, isNotNull } from "drizzle-orm";
import { closeDatabaseConnections, getDb } from "../src/db/client.js";
import { jobApplications } from "../src/db/schema.js";
import { formatTable, groupByBand } from "../src/tools/jobhunt/ats-outcome.js";

const flag = process.argv.indexOf("--profile");
const profileId = flag >= 0 ? process.argv[flag + 1] : undefined;

try {
  const rows = await getDb()
    .select({ applied_at: jobApplications.applied_at, stage: jobApplications.stage, ats_json: jobApplications.ats_json })
    .from(jobApplications)
    .where(profileId ? and(isNotNull(jobApplications.applied_at), eq(jobApplications.profile_id, profileId)) : isNotNull(jobApplications.applied_at));
  console.log(`Sent applications: ${rows.length}${profileId ? ` (profile ${profileId})` : ""}`);
  console.log(formatTable(groupByBand(rows)));
} finally {
  await closeDatabaseConnections();
}
