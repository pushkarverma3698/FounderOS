/**
 * Re-run every STORED posting through the current gates, in place. $0 — no
 * network, no model, no actor run.
 *
 * (Not to be confused with `jobhunt-rescreen.ts`, which previews gate changes
 * from a JSON dump and never touches the database. This one writes.)
 *
 * WHY IT EXISTS. Two facts about the rows already in `job_applications`:
 *
 *   1. None of them carry `gate_json`, so the brief cannot say WHICH check
 *      passed and every line on them renders as unconfirmed. That is honest, but
 *      it is honest about a gap we can simply close: the posting BODY is stored,
 *      and the gates are pure functions of it.
 *   2. Some carry verdicts from a screener that has since been fixed. On
 *      2026-08-01 three live rows claimed "€401000 … Read from: '401k'" — a US
 *      retirement-plan benefit read as a salary. Those rows keep saying it until
 *      something re-reads the text.
 *
 * `screenPosting` upserts on the dedupe key, so this REFRESHES rows rather than
 * duplicating them, and `stage` survives the update. Rows the founder has
 * already engaged with are skipped by `screenPosting` itself — re-screening must
 * never disturb an application in flight.
 *
 *   set -a && . ./.env && set +a && npx tsx scripts/jobhunt-backfill-gates.ts [--dry]
 */

import { listRecentApplications } from "../src/db/job-queries.js";
import { toPostingCountry } from "../src/tools/jobhunt/country.js";
import { screenPosting } from "../src/tools/jobhunt/screen.js";

const DRY = process.argv.includes("--dry");

async function main(): Promise<void> {
  const rows = await listRecentApplications({ limit: 1000 });
  console.log(
    `${rows.length} stored postings.${DRY ? "  DRY RUN — nothing will be written." : ""}\n`,
  );

  const tally = { pass: 0, flag: 0, reject: 0, engaged: 0, noBody: 0, error: 0 };
  const changes: string[] = [];

  for (const row of rows) {
    // Without the body there is nothing to re-read, and re-screening on the
    // title alone would replace a real verdict with a guess.
    if (!row.description || row.description.trim().length === 0) {
      tally.noBody += 1;
      continue;
    }
    if (DRY) continue;

    const outcome = await screenPosting({
      company: row.company,
      title: row.title,
      description: row.description,
      ...(row.url ? { url: row.url } : {}),
      ...(row.posted_at ? { postedAt: row.posted_at } : {}),
      source: row.source,
      ...(row.external_id ? { externalId: row.external_id } : {}),
      // CARRIED FORWARD, not re-derived. Without these a backfill would rewrite
      // every row's country to `unknown` — destroying a fact the fetcher
      // established — because this script has no feed to ask. A row that never
      // had one stays `unknown`, which is the truth about it: it was screened by
      // a pipeline that did not record where the job was.
      ...(row.country ? { country: toPostingCountry(row.country) } : {}),
      ...(row.location ? { location: row.location } : {}),
    });

    if (outcome.kind === "error") {
      tally.error += 1;
      console.log(`  ✗ ${row.company} — ${row.title}: ${outcome.message}`);
      continue;
    }
    if (outcome.kind === "duplicate") {
      tally.engaged += 1;
      continue;
    }

    tally[outcome.verdict.status] += 1;
    if (outcome.verdict.status !== row.salary_status) {
      changes.push(
        `  ${row.salary_status.padEnd(6)} → ${outcome.verdict.status.padEnd(6)}  ` +
          `${row.company} — ${row.title}`,
      );
    }
  }

  console.log(
    `pass ${tally.pass} · flag ${tally.flag} · reject ${tally.reject} · ` +
      `already engaged ${tally.engaged} · no body ${tally.noBody} · errors ${tally.error}`,
  );

  if (changes.length > 0) {
    console.log(`\n${changes.length} verdict(s) changed:\n${changes.join("\n")}`);
  } else if (!DRY) {
    console.log("\nNo verdict changed — every row now also carries its per-check record.");
  }
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error("Backfill failed:", (err as Error).message);
  process.exit(1);
});
