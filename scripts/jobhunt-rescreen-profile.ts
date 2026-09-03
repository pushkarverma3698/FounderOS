/**
 * FounderOS — Rescreen 12k+ database pool for a target JobSearchProfile
 * =====================================================================
 * Re-evaluates all stored job applications in Postgres against a specific candidate profile.
 *
 * Usage:
 *   npx tsn scripts/jobhunt-rescreen-profile.ts <profile_id>
 *   npx tsn scripts/jobhunt-rescreen-profile.ts wife-nl-finance
 */

import { getDb } from "../src/db/client.js";
import { jobApplications } from "../src/db/schema.js";
import { eq, or, isNull } from "drizzle-orm";
import { getProfile } from "../src/tools/jobhunt/profile-config.js";
import { screenPosting } from "../src/tools/jobhunt/screen.js";
import { childLogger } from "../src/infra/logger.js";

const log = childLogger({ module: "script:rescreen-profile" });

async function main() {
  const profileId = process.argv[2] ?? "wife-nl-finance";
  log.info({ profileId }, "Starting pool rescreening for profile");

  let profile;
  try {
    profile = getProfile(profileId);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }

  const db = getDb();
  
  // Fetch candidate postings for target countries
  const targetCodes = profile.targetCountries.map((c) => c.code);
  log.info({ targetCodes }, "Querying existing job applications from database");

  const rows = await db
    .select()
    .from(jobApplications);

  console.log(`Loaded ${rows.length} total job application rows from DB.`);

  let totalScreened = 0;
  let passed = 0;
  let flagged = 0;
  let rejected = 0;
  let errors = 0;

  const matches: Array<{ company: string; title: string; outcome: string; detail: string }> = [];

  for (const row of rows) {
    if (!row.description) continue;

    totalScreened++;
    try {
      const outcome = await screenPosting({
        company: row.company,
        title: row.title,
        description: row.description,
        ...(row.url ? { url: row.url } : {}),
        ...(row.country ? { country: row.country as any } : {}),
        ...(row.location ? { location: row.location } : {}),
        source: "pool-rescreen",
        profile,
      });

      if (outcome.kind === "screened") {
        if (outcome.verdict.status === "pass") {
          passed++;
          matches.push({ company: row.company, title: row.title, outcome: "PASS", detail: outcome.route });
        } else if (outcome.verdict.status === "flag") {
          flagged++;
          matches.push({ company: row.company, title: row.title, outcome: "FLAG", detail: outcome.verdict.reasons[0] ?? "" });
        } else {
          rejected++;
        }
      } else if (outcome.kind === "error") {
        errors++;
      }
    } catch (err) {
      errors++;
    }

    if (totalScreened % 500 === 0) {
      console.log(`Progress: ${totalScreened}/${rows.length} screened | Passed: ${passed} | Flagged: ${flagged}`);
    }
  }

  console.log("\n=========================================");
  console.log(`RESCREENING COMPLETE for Profile: ${profile.candidateName} (${profile.id})`);
  console.log(`Total Rows Analyzed: ${totalScreened}`);
  console.log(`Passed (Apply Ready): ${passed}`);
  console.log(`Flagged (Stretch / Check): ${flagged}`);
  console.log(`Rejected (Mismatched): ${rejected}`);
  console.log(`Errors: ${errors}`);
  console.log("=========================================\n");

  if (matches.length > 0) {
    console.log("TOP MATCHES FOUND:");
    matches.slice(0, 20).forEach((m, i) => {
      console.log(`${i + 1}. [${m.outcome}] ${m.company} — ${m.title} (${m.detail})`);
    });
  }
}

main().catch((err) => {
  console.error("Rescreening failed:", err);
  process.exit(1);
});
