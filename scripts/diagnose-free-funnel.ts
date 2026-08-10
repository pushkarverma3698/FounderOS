/**
 * FounderOS — free job lane funnel diagnostic (READ ONLY)
 * ========================================================
 * Answers one question with numbers instead of a hypothesis: of the ~20,550
 * candidates the free lane observes every 30 minutes, WHICH STAGE drops them?
 *
 * Prod has logged `seen=20554 screened=0` on ~144 consecutive sweeps. The drop
 * counts are already computed inside `filterCandidates` and then thrown away on
 * a quiet sweep, which is exactly why this has been invisible.
 *
 * Touches nothing: fetches the boards, runs the SAME pure filter the sweep runs,
 * prints the funnel. No DB writes, no screening, no notifications, no cost.
 *
 *   pnpm tsx scripts/diagnose-free-funnel.ts            # all boards
 *   pnpm tsx scripts/diagnose-free-funnel.ts --boards 25
 *   pnpm tsx scripts/diagnose-free-funnel.ts --age 168   # widen the window
 */

import { getFreeBoards } from "../src/tools/jobhunt/free-boards.js";
import { sweepBoards } from "../src/tools/jobhunt/free-ats-source.js";
import { FREE_LANE_MAX_AGE_HOURS } from "../src/tools/jobhunt/free-ingest.js";
import { classifyTrack } from "../src/tools/jobhunt/tracks.js";
import { countryFromLocation } from "../src/tools/jobhunt/country.js";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const boardLimit = Number(arg("--boards") ?? 0);
const maxAgeHours = Number(arg("--age") ?? FREE_LANE_MAX_AGE_HOURS);

function hoursSince(d: Date, now: Date): number {
  return (now.getTime() - d.getTime()) / 3_600_000;
}

function pct(n: number, total: number): string {
  return total === 0 ? "—" : `${((n / total) * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const now = new Date();
  const all = getFreeBoards();
  const boards = boardLimit > 0 ? all.slice(0, boardLimit) : all;

  console.log(`\nFREE LANE FUNNEL — ${now.toISOString()}`);
  console.log(`boards=${boards.length}/${all.length}  maxAgeHours=${maxAgeHours}\n`);

  const sweep = await sweepBoards(boards);
  const total = sweep.candidates.length;

  // Stage counters — mirrors filterCandidates exactly, but attributes EVERY
  // candidate to the FIRST gate that rejects it (same short-circuit order).
  let undated = 0, stale = 0, offTrack = 0, offMarket = 0, kept = 0;
  const ageBuckets = new Map<string, number>();
  const trackHits = new Map<string, number>();
  const countryHits = new Map<string, number>();
  const staleSamples: string[] = [];

  for (const c of sweep.candidates) {
    // Independent observations, so we can see what WOULD pass each gate alone.
    const track = classifyTrack(c.title);
    if (track) trackHits.set(track, (trackHits.get(track) ?? 0) + 1);
    const country = countryFromLocation(c.location);
    countryHits.set(country, (countryHits.get(country) ?? 0) + 1);

    if (c.postedAt === null) {
      undated += 1;
      ageBuckets.set("undated", (ageBuckets.get("undated") ?? 0) + 1);
      continue;
    }
    const age = hoursSince(c.postedAt, now);
    const bucket =
      age <= 6 ? "0-6h" : age <= 24 ? "6-24h" : age <= 72 ? "1-3d" :
      age <= 168 ? "3-7d" : age <= 720 ? "7-30d" : ">30d";
    ageBuckets.set(bucket, (ageBuckets.get(bucket) ?? 0) + 1);

    if (age > maxAgeHours) {
      stale += 1;
      if (staleSamples.length < 5) {
        staleSamples.push(`${age.toFixed(0)}h  ${c.board.name} — ${c.title}`);
      }
      continue;
    }
    if (track === null) { offTrack += 1; continue; }
    if (country === "other") { offMarket += 1; continue; }
    kept += 1;
  }

  console.log("SEQUENTIAL FUNNEL (first gate that rejects wins)");
  console.log(`  fetched                 ${total}`);
  console.log(`  ├─ dropped: undated     ${undated}\t${pct(undated, total)}`);
  console.log(`  ├─ dropped: stale >${maxAgeHours}h  ${stale}\t${pct(stale, total)}`);
  console.log(`  ├─ dropped: off-track   ${offTrack}\t${pct(offTrack, total)}`);
  console.log(`  ├─ dropped: off-market  ${offMarket}\t${pct(offMarket, total)}`);
  console.log(`  └─ KEPT to dedupe       ${kept}\t${pct(kept, total)}`);

  console.log("\nAGE DISTRIBUTION (what the freshness gate is actually seeing)");
  for (const b of ["undated", "0-6h", "6-24h", "1-3d", "3-7d", "7-30d", ">30d"]) {
    const n = ageBuckets.get(b) ?? 0;
    if (n > 0) console.log(`  ${b.padEnd(9)} ${String(n).padStart(6)}\t${pct(n, total)}`);
  }

  console.log("\nTRACK MATCHES (title classifier, independent of other gates)");
  const trackTotal = [...trackHits.values()].reduce((a, b) => a + b, 0);
  console.log(`  any track ${trackTotal}\t${pct(trackTotal, total)}`);
  for (const [t, n] of [...trackHits].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${t.padEnd(10)} ${String(n).padStart(6)}`);
  }

  console.log("\nCOUNTRY (independent of other gates)");
  for (const [c, n] of [...countryHits].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${c.padEnd(9)} ${String(n).padStart(6)}\t${pct(n, total)}`);
  }

  if (staleSamples.length > 0) {
    console.log("\nSTALE SAMPLES");
    for (const s of staleSamples) console.log(`  ${s}`);
  }

  if (sweep.failures.length > 0) {
    console.log(`\nBOARD FAILURES (${sweep.failures.length})`);
    for (const f of sweep.failures.slice(0, 5)) console.log(`  ${f}`);
  }

  console.log(
    `\nVERDICT: ${kept === 0 ? "FUNNEL CLOSED — nothing reaches screening." : `${kept} candidate(s) would reach dedupe.`}\n`,
  );
}

main().catch((err) => {
  console.error("diagnostic failed:", err);
  process.exit(1);
});
