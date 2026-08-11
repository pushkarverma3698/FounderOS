/**
 * Live e2e for the jobhunt outcome pipeline.
 *
 * Runs the REAL path the daily scheduler runs: fetch (Apify, paid) → screen →
 * persist → rank → verify liveness → render the brief. Nothing is mocked.
 *
 * Costs real money (Apify pay-per-event). Run it deliberately, not in a loop.
 *
 *   APIFY_TOKEN=… node --env-file=.env --import tsx/esm scripts/jobhunt-live-e2e.ts [limit]
 */

import { runPooledIngest } from "../src/tools/jobhunt/ingest.js";
import { buildDailyBrief } from "../src/tools/jobhunt/daily-brief.js";

const limit = Number(process.argv[2] ?? 30);

function section(title: string): void {
  console.log(`\n${"═".repeat(72)}\n${title}\n${"═".repeat(72)}`);
}

async function main(): Promise<void> {
  if (!process.env["APIFY_TOKEN"]) throw new Error("APIFY_TOKEN is not set");

  section(`INGEST — limit ${limit}, pools + Indeed`);
  const startedAt = Date.now();
  const ingest = await runPooledIngest({ limit, includeIndeed: true });
  const ingestMs = Date.now() - startedAt;

  console.log(`fetched:  ${ingest.fetched}`);
  console.log(`screened: ${ingest.lines.length}`);
  console.log(`failures: ${ingest.failures.length}`);
  for (const f of ingest.failures) console.log(`  ✗ ${f}`);
  console.log(`elapsed:  ${(ingestMs / 1000).toFixed(1)}s`);

  const byOutcome = new Map<string, number>();
  for (const line of ingest.lines) {
    byOutcome.set(line.outcome, (byOutcome.get(line.outcome) ?? 0) + 1);
  }
  console.log(`verdicts: ${[...byOutcome].map(([k, v]) => `${k}=${v}`).join(" ") || "none"}`);

  section("SCREENED LINES");
  for (const line of ingest.lines) {
    console.log(`[${line.outcome.padEnd(9)}] ${line.company} — ${line.title}\n    ${line.detail}`);
  }

  section("DAILY BRIEF (live liveness checks)");
  const briefStartedAt = Date.now();
  const brief = await buildDailyBrief({
    screened: ingest.lines.length,
    failures: ingest.failures,
  });
  console.log(brief);
  console.log(`\n[brief built in ${((Date.now() - briefStartedAt) / 1000).toFixed(1)}s]`);
}

main().catch((err) => {
  console.error("LIVE E2E FAILED:", err);
  process.exit(1);
});
