/**
 * ONE live actor run: what the Dutch AI/ML/agent market is actually asking for.
 *
 * Feeds the weekly CV hardening pass. Deliberately NOT part of the sweep and
 * deliberately NOT writing to `job_applications` or `job_ingest_runs`:
 *   · storing these would pollute the dedupe table with roles nobody screened
 *     for applying, and
 *   · billing them to the ingest ledger would corrupt the cost-per-new-role
 *     figure the sweep cadence is now decided from (a manual research fetch is
 *     not a sweep, and averaging the two hides both).
 *
 * Costs one actor start plus one charge per job returned. At FREE tier that is
 * $0.01 + $0.012/job — roughly $0.30 for a full run.
 *
 *   set -a && . ./.env && set +a && npx tsx scripts/cv-market-scan.ts
 */

import { writeFileSync } from "node:fs";
import { fetchAtsPostings, POOL_QUERIES } from "../src/tools/jobhunt/ats-source.js";
import { getSponsorRegister } from "../src/tools/jobhunt/sponsor-registry.js";
import { matchSponsor } from "../src/tools/jobhunt/sponsor-match.js";
import { extractPostingFacts } from "../src/tools/jobhunt/extract.js";
import { HSM_UNDER_30_ANNUAL_BASE_EUR, screenSalaryFacts } from "../src/tools/jobhunt/filters.js";

/** AI/ML/agent-native titles. One query, so one actor start covers all of them. */
const TITLES = [
  "AI Engineer:*",
  "AI Developer:*",
  "Machine Learning Engineer:*",
  "LLM Engineer:*",
  "MLOps Engineer:*",
  "GenAI:*",
  "Applied AI:*",
  "Agent Engineer:*",
  "Forward Deployed:*",
];

const LIMIT = 30;

const result = await fetchAtsPostings({
  ...POOL_QUERIES["netherlands"],
  titles: TITLES,
  // 7d rather than 24h: this runs weekly and needs a week of supply, not a day.
  timeRange: "7d",
  limit: LIMIT,
  // NOT the sweep's 0-2/2-5. The sweep filters to roles Pushkar can be
  // shortlisted for TODAY; this scan is reading the market's vocabulary, and
  // the senior band is where the language he should be growing into lives.
  // Filtering it out would make the CV chase the level he already has.
  experienceLevels: ["0-2", "2-5", "5-10"],
});

if (!result.ok) {
  console.error(`FETCH FAILED — ${result.error}`);
  process.exit(1);
}

const register = getSponsorRegister();
console.log(
  `Returned ${result.postings.length} posting(s). ` +
    `Register: ${register.index.size} entries, scraped ${register.scrapedAt}\n`,
);

const rows = result.postings.map((p) => {
  const match = matchSponsor(p.company, register.index);
  const facts = extractPostingFacts(p.description, "NL");
  // The SAME salary screen the pipeline uses, not a second implementation.
  // Hand-rolling the annualisation here got the unit vocabulary wrong
  // ("month"/"year" instead of "monthly"/"annual"), so every stated figure
  // silently annualised to zero and six ads that DO quote pay printed as
  // "unstated" — a filter reporting the market as quieter than it is. This
  // version also inherits the holiday-basis and part-time FTE handling.
  //
  // `reject` means the ad states pay below the €52,284 under-30 HSM base. An
  // ad that states nothing comes back `flag`, not `reject`: unknown is not
  // the same as too low, and Dutch ads omit pay as a rule.
  const pay = screenSalaryFacts(facts.salary, { route: "hsm" });

  return {
    company: p.company,
    title: p.title,
    url: p.url,
    location: p.location,
    sponsor: match.verdict,
    sponsorEvidence: match.evidence,
    pay: pay.status,
    payEvidence: pay.evidence,
    salaryRaw: facts.salary.raw ?? null,
    belowFloor: pay.status === "reject",
    descriptionChars: p.description.length,
    description: p.description,
  };
});

for (const r of rows) {
  const flag = r.belowFloor ? "  ✗ BELOW FLOOR — unusable as evidence" : "";
  console.log(
    `[${r.sponsor.padEnd(12)}] ${r.company} — ${r.title}\n` +
      `    ${r.location} · pay ${r.pay}${r.salaryRaw ? ` "${r.salaryRaw}"` : ""} · ` +
      `${r.descriptionChars} chars${flag}`,
  );
}

const usable = rows.filter((r) => r.sponsor === "sponsor" && !r.belowFloor);
console.log(
  `\n${usable.length} usable as market evidence ` +
    `(register-confirmed sponsor, not stated below €${HSM_UNDER_30_ANNUAL_BASE_EUR.toLocaleString()}).`,
);

writeFileSync("/tmp/cv-market-scan.json", JSON.stringify(rows, null, 2));
console.log("Full ad text → /tmp/cv-market-scan.json");
