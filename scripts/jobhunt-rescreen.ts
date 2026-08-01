/**
 * Re-screen already-fetched postings through the CURRENT gates. Zero API spend.
 *
 * Reads a JSON array of { company, title, description, was, wasRoute } — the
 * shape `agents.job_applications` dumps — and prints the verdict each posting
 * gets now against the verdict it was stored with.
 *
 * Purpose: prove a gate change moved real founder-facing outcomes, not just unit
 * tests. Uses only the PURE gate functions, so it needs no database and cannot
 * write anything.
 *
 *   npx tsx scripts/jobhunt-rescreen.ts prodjobs.tmp.json
 */

import { readFileSync } from "node:fs";
import { extractPostingFacts } from "../src/tools/jobhunt/extract.js";
import { screenSalaryFacts, screenLanguage } from "../src/tools/jobhunt/filters.js";
import { basesForPosting, gateProfile } from "../src/tools/jobhunt/permit-routes.js";
import { isEarlyCareerTitle } from "../src/tools/jobhunt/seniority.js";

interface Row {
  company: string;
  title: string;
  description: string;
  was: string;
  wasRoute: string;
}

const path = process.argv[2];
if (!path) {
  console.error("usage: tsx scripts/jobhunt-rescreen.ts <rows.json>");
  process.exit(1);
}

const rows = JSON.parse(readFileSync(path, "utf8")) as Row[];
const rank: Record<string, number> = { pass: 0, flag: 1, reject: 2 };

let changed = 0;
let dropped = 0;

for (const row of rows) {
  if (isEarlyCareerTitle(row.title)) {
    dropped += 1;
    console.log(`DROPPED (early career)  ${row.company} — ${row.title}`);
    continue;
  }

  const facts = extractPostingFacts(row.description);
  const language = screenLanguage(row.description);

  // The sponsor gate needs the IND register; it is not what changed here, so a
  // posting is scored on the gates that are pure inputs. Under a basis that
  // requires a sponsor we keep the STORED verdict, so nothing is overstated.
  const outcomes = basesForPosting(facts.route).map((basis) => {
    const profile = gateProfile(basis);
    const salary = screenSalaryFacts(facts.salary, { route: basis });
    if (profile.sponsorRequired) return { basis, status: row.was };
    const statuses = [salary.status, language.status];
    const worst = statuses.sort((a, b) => rank[b]! - rank[a]!)[0]!;
    return { basis, status: worst };
  });

  const best = [...outcomes].sort((a, b) => rank[a.status]! - rank[b.status]!)[0]!;
  const flagChanged = best.status !== row.was;
  if (flagChanged) changed += 1;

  console.log(
    `${flagChanged ? "CHANGED" : "same   "}  ${row.was.padEnd(6)} -> ${best.status.padEnd(6)} ` +
      `[${best.basis}]  ${row.company} — ${row.title}`,
  );
}

console.log(`\n${rows.length} rows · ${changed} changed · ${dropped} dropped as early-career`);
