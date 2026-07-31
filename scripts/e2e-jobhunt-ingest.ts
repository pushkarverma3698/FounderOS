#!/usr/bin/env tsx
/**
 * E2E — job-hunt ingest pipeline, live.
 * =====================================
 * Runs the REAL path end to end and prints what each stage actually produced:
 *
 *   Apify ATS feed → mapAtsItems → screenPosting (gates) → agents.job_applications
 *                                                        → agents.cv_signals
 *                  → review_screened → cv_gaps
 *
 * Nothing is mocked. Nothing is stubbed. If the feed is down, this says so
 * rather than reporting an empty market.
 *
 * Cost: one actor run (~$0.01 start + ~$0.012/job). At the default limit of 10
 * that is ~$0.13. No LLM is called at any point.
 *
 * Usage:
 *   APIFY_TOKEN=... pnpm tsx scripts/e2e-jobhunt-ingest.ts [--limit 10] [--range 7d]
 *
 * The token is required because there is deliberately no fallback: screening a
 * search snippet would produce a confident verdict from evidence never fetched.
 */

import { fetchAtsPostings } from "../src/tools/jobhunt/ats-source.js";
import { screenBatch, formatIngestSummary } from "../src/tools/jobhunt/ingest.js";
import { reviewScreenedTool } from "../src/tools/jobhunt/review.js";
import { cvGapsTool } from "../src/tools/jobhunt/gaps.js";
import { listSignals } from "../src/db/cv-signal-queries.js";
import { countPassingApplications } from "../src/db/job-queries.js";

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

function heading(step: string, title: string): void {
  console.log(`\n${"═".repeat(72)}\n${step}  ${title}\n${"═".repeat(72)}`);
}

async function main(): Promise<void> {
  const limit = Number(arg("--limit", "10"));
  const range = arg("--range", "7d") as "1h" | "24h" | "7d" | "6m";

  if (!process.env["APIFY_TOKEN"]) {
    console.error(
      "APIFY_TOKEN is not set. This script runs the real feed on purpose — there is " +
        "no offline mode, because a pipeline verified against a fixture proves nothing " +
        "about the pipeline.",
    );
    process.exit(1);
  }

  heading("STEP 1", `FETCH — Apify ATS feed (limit ${limit}, range ${range})`);
  const t0 = Date.now();
  const fetched = await fetchAtsPostings({ limit, timeRange: range });
  if (!fetched.ok) {
    console.error(`FETCH FAILED: ${fetched.error}`);
    console.error("Nothing was screened. This is an outage, not an empty market.");
    process.exit(2);
  }
  console.log(`Fetched ${fetched.postings.length} usable postings in ${Date.now() - t0}ms\n`);
  for (const p of fetched.postings) {
    console.log(
      `  · ${p.company} — ${p.title}\n` +
        `      ${p.location} · posted ${p.postedAt?.toISOString() ?? "unknown"} · ` +
        `${p.description.length} chars of body`,
    );
  }

  heading("STEP 2", "SCREEN — the same gates the founder's manual paste uses");
  const t1 = Date.now();
  const lines = await screenBatch(fetched.postings);
  console.log(`Screened ${lines.length} postings in ${Date.now() - t1}ms\n`);
  console.log(formatIngestSummary({ fetched: fetched.postings.length, lines }));

  heading("STEP 3", "PERSIST — read the rows back out of Postgres");
  const review = await reviewScreenedTool.execute({ limit: 15 });
  console.log(review.success ? review.data : `REVIEW FAILED: ${review.error}`);

  heading("STEP 4", "SIGNALS — what the passing postings asked for");
  const signals = await listSignals({ limit: 25 });
  const passing = await countPassingApplications();
  console.log(`cv_signals rows: ${signals.length} · passing postings: ${passing}\n`);
  for (const s of signals.slice(0, 20)) {
    console.log(`  · ${s.term.padEnd(24)} ${String(s.seen_count).padStart(3)}  [${s.category}]`);
  }

  heading("STEP 5", "CV GAPS — market demand vs. the CV");
  const gaps = await cvGapsTool.execute({});
  console.log(gaps.success ? gaps.data : `GAPS FAILED: ${gaps.error}`);

  console.log(`\n${"═".repeat(72)}\nE2E COMPLETE — every stage above ran against live systems.\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error("E2E FAILED:", err);
  process.exit(1);
});
