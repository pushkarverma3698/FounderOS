/**
 * Screen the standing inventory the freshness filter has been discarding
 * ======================================================================
 * The free lane drops every posting older than `FREE_LANE_MAX_AGE_HOURS` (720h
 * = 30 days) BEFORE it checks whether it has seen the posting before. Its own
 * log line calls those rows "seen in an earlier sweep", which is a claim the
 * code cannot make: `filterCandidates` runs ahead of `keepUnseen` and has no
 * database knowledge at all.
 *
 * The arithmetic settles what that costs. On 2026-08-21 production held 554
 * rows in `job_applications` lifetime, and discarded 24,446 postings as stale
 * every thirty minutes. At most 554 of them had ever been seen — so ≥23,892
 * were open roles that had never been screened once and, under the standing
 * rule, never would be.
 *
 * It is a COLD-START defect, and it re-fires on every registry expansion: the
 * board list went 285 → 623 → 858 over 2026-08-20/21, and each new board's
 * entire back catalogue was discarded on its first poll. The daily `returned`
 * series shows it exactly — 0, 2, 5, 6, 7 while the registry was flat, then 58
 * and 167 the moment boards were added.
 *
 * THIS SCRIPT IS THE ONE-OFF, NOT A POLICY CHANGE (founder decision,
 * 2026-08-21). Steady-state sweeps keep the 720h window; this runs once to
 * screen the inventory that window has been hiding.
 *
 * It is cheap, and the funnel says why: `offTrack` and `offMarket` are decided
 * from the title and location ALREADY IN the list response, so the ~24k stale
 * rows cost zero extra fetches. At the measured rates (12.6% on-track, 22% of
 * those in-market) only ~680 rows reach hydration and screening.
 *
 *   node --env-file=.env --import tsx/esm scripts/jobhunt-backfill-stale.ts --dry-run
 *   node --env-file=.env --import tsx/esm scripts/jobhunt-backfill-stale.ts
 *   node --env-file=.env --import tsx/esm scripts/jobhunt-backfill-stale.ts --chunk 25 --from 200
 *
 * Zero LLM: the fetch is HTTP and every gate is pure code, so this costs
 * nothing but time and third-party politeness.
 */

import { getFreeBoards, type FreeBoard } from "../src/tools/jobhunt/free-boards.js";
import { sweepBoards } from "../src/tools/jobhunt/free-ats-source.js";
import {
  filterCandidates,
  runFreeIngest,
  FREE_LANE_MAX_AGE_HOURS,
} from "../src/tools/jobhunt/free-ingest.js";

/** No age filter at all — the whole point of the run. */
const NO_AGE_LIMIT = Number.POSITIVE_INFINITY;

/**
 * Boards per batch. Small enough that one Recruitee 429 storm costs one batch
 * rather than the run, and that a killed process loses at most this much work.
 */
const DEFAULT_CHUNK = 30;

function numArg(flag: string, fallback: number): number {
  const args = process.argv.slice(2);
  const i = args.indexOf(flag);
  const raw = i === -1 ? args.find((a) => a.startsWith(`${flag}=`))?.split("=")[1] : args[i + 1];
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * What the run WOULD do, without writing a row or fetching a single body.
 *
 * Prints both funnels side by side, because the number that justifies the run is
 * not "how many are stale" — it is how many stale rows are on-track and
 * in-market, which is the only cohort that would ever have reached screening.
 */
async function dryRun(boards: readonly FreeBoard[]): Promise<void> {
  const now = new Date();
  const sweep = await sweepBoards(boards);

  const current = filterCandidates(sweep.candidates, now, FREE_LANE_MAX_AGE_HOURS);
  const backfill = filterCandidates(sweep.candidates, now, NO_AGE_LIMIT);

  const gained = backfill.kept.length - current.kept.length;
  console.log(`\nboards polled ${sweep.boardsPolled} · failed ${sweep.failures.length}`);
  console.log(`seen ${sweep.candidates.length}`);
  console.log(
    `\n  with the ${FREE_LANE_MAX_AGE_HOURS}h window (today):` +
      `\n    stale ${current.counts.stale} · offTrack ${current.counts.offTrack} · offMarket ${current.counts.offMarket}` +
      `\n    reaching the tracker: ${current.kept.length}`,
  );
  console.log(
    `\n  with no window (this backfill):` +
      `\n    stale 0 · offTrack ${backfill.counts.offTrack} · offMarket ${backfill.counts.offMarket}` +
      `\n    reaching the tracker: ${backfill.kept.length}`,
  );
  console.log(
    `\n  → ${gained} extra on-track, in-market postings would be screened.` +
      `\n    (Of these, whatever is already in the tracker is dropped by keepUnseen,` +
      `\n     which this dry run deliberately does not touch — no DB, no body fetches.)\n`,
  );

  if (sweep.failures.length > 0) {
    console.log(`board failures: ${sweep.failures.slice(0, 5).join(" · ")}`);
  }
}

/** The real run: same path the sweep takes, with the age gate lifted. */
async function backfill(boards: readonly FreeBoard[], chunk: number): Promise<void> {
  let screened = 0;
  let seen = 0;
  const failures: string[] = [];

  for (let i = 0; i < boards.length; i += chunk) {
    const batch = boards.slice(i, i + chunk);
    const at = `${i + 1}–${Math.min(i + chunk, boards.length)} of ${boards.length}`;
    process.stderr.write(`[boards ${at}] polling…\n`);

    try {
      const result = await runFreeIngest({ boards: batch, maxAgeHours: NO_AGE_LIMIT });
      seen += result.seen;
      screened += result.screened;
      failures.push(...result.failures);
      process.stderr.write(
        `[boards ${at}] seen ${result.seen} · screened ${result.screened} · ` +
          `stale-that-were-kept ${result.funnel.stale === 0 ? "all" : result.funnel.stale} · ` +
          `known ${result.funnel.known}\n`,
      );
    } catch (err) {
      // One batch failing must not cost the run. The next `--from` value is
      // printed so a killed run resumes without redoing the boards that landed.
      const msg = err instanceof Error ? err.message : String(err);
      failures.push(`batch ${at}: ${msg}`);
      process.stderr.write(`[boards ${at}] FAILED: ${msg}\n  resume with --from ${i}\n`);
    }
  }

  console.log(`\nbackfill complete · seen ${seen} · newly screened ${screened}`);
  if (failures.length > 0) {
    console.log(`${failures.length} board/batch failure(s):`);
    for (const f of failures.slice(0, 20)) console.log(`  ${f}`);
  }
}

async function main(): Promise<void> {
  const all = getFreeBoards();
  const from = numArg("--from", 0);
  const limit = numArg("--limit", all.length);
  const boards = all.slice(from, from + limit);
  const chunk = numArg("--chunk", DEFAULT_CHUNK);

  console.error(
    `registry ${all.length} boards · running ${boards.length} (from ${from}) · chunk ${chunk}`,
  );

  if (process.argv.includes("--dry-run")) {
    await dryRun(boards);
    return;
  }
  await backfill(boards, chunk);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
