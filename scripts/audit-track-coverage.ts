/**
 * What the track classifier is throwing away
 * ==========================================
 * The free lane sees ~20,600 postings a sweep and screens 5. The single
 * largest discard after staleness is `offTrack` — 5,866 postings on
 * 2026-08-20, which is 89.5% of everything that survived the freshness
 * filter. That number is a COUNT and nothing else: `filterCandidates` drops
 * the titles without storing them, so "we are missing engineering roles" and
 * "those really were all concept artists" are the same number from outside.
 *
 * This script closes that gap. It polls a sample of the real registry, runs
 * the real `classifyTrack` over the real titles, and prints what came back
 * null — ranked by frequency, so the vocabulary gap is measured rather than
 * imagined.
 *
 *   node --import tsx/esm scripts/audit-track-coverage.ts --boards 60
 *   node --import tsx/esm scripts/audit-track-coverage.ts --boards 60 --json
 *   node --import tsx/esm scripts/audit-track-coverage.ts --boards 60 --profile tashi
 *
 * Free: these are the same unauthenticated endpoints the sweep already polls.
 */

import { getFreeBoards } from "../src/tools/jobhunt/free-boards.js";
import { sweepBoards } from "../src/tools/jobhunt/free-ats-source.js";
import { classifyTrack } from "../src/tools/jobhunt/tracks.js";
import { countryFromLocation } from "../src/tools/jobhunt/country.js";
import {
  getProfile,
  resolveProfileToken,
  type JobSearchProfile,
} from "../src/tools/jobhunt/profile-config.js";

function argValue(flag: string, fallback: number): number {
  const args = process.argv.slice(2);
  const i = args.indexOf(flag);
  if (i === -1) return fallback;
  const raw = args[i + 1] ?? args[i]?.split("=")[1];
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function argText(flag: string): string | null {
  const args = process.argv.slice(2);
  const i = args.indexOf(flag);
  if (i === -1) {
    const inline = args.find((a) => a.startsWith(`${flag}=`));
    return inline ? (inline.split("=")[1] ?? null) : null;
  }
  return args[i + 1] ?? null;
}

/**
 * Which candidate's vocabulary to measure.
 *
 * Defaulted silently until 2026-09-07, which made this script structurally
 * unable to answer the question it exists for on the SECOND profile: both
 * `classifyTrack` and `countryFromLocation` fall back to the default profile,
 * so an audit run while asking "why does Tashi's lane pass so few roles?"
 * measured Pushkar's tracks against Pushkar's markets and reported a healthy
 * funnel. An unknown token exits rather than defaulting — quietly auditing the
 * wrong person is the exact failure this replaces.
 */
function resolveAuditProfile(): JobSearchProfile {
  const token = argText("--profile");
  if (token === null) return getProfile();
  const id = resolveProfileToken(token);
  if (id === null) {
    console.error(`Unknown --profile "${token}". Pass a profile id, an id segment, or a first name.`);
    process.exit(1);
  }
  return getProfile(id);
}

/** Evenly spread the sample across the registry so it is not 60 Greenhouse boards. */
function sample<T>(items: readonly T[], n: number): T[] {
  if (n >= items.length) return [...items];
  const step = items.length / n;
  return Array.from({ length: n }, (_, i) => items[Math.floor(i * step)]!);
}

async function main(): Promise<void> {
  const boardCount = argValue("--boards", 60);
  const asJson = process.argv.includes("--json");
  const profile = resolveAuditProfile();
  const boards = sample(getFreeBoards(), boardCount);

  console.error(
    `Polling ${boards.length} of ${getFreeBoards().length} boards for ${profile.candidateName} (${profile.id})…`,
  );
  const sweep = await sweepBoards(boards);

  const unclassified = new Map<string, number>();
  const classified = new Map<string, number>();
  let offMarket = 0;

  for (const candidate of sweep.candidates) {
    const track = classifyTrack(candidate.title, profile);
    if (track === null) {
      const key = candidate.title.toLowerCase().trim();
      unclassified.set(key, (unclassified.get(key) ?? 0) + 1);
      continue;
    }
    classified.set(track, (classified.get(track) ?? 0) + 1);
    if (countryFromLocation(candidate.location, profile) === "other") offMarket += 1;
  }

  const ranked = [...unclassified.entries()].sort((a, b) => b[1] - a[1]);
  const totalUnclassified = ranked.reduce((sum, [, n]) => sum + n, 0);

  if (asJson) {
    // One row per posting, not a summary: the whole point is that a count
    // cannot answer "which engineering titles did we drop?".
    for (const candidate of sweep.candidates) {
      console.log(
        JSON.stringify({
          profile: profile.id,
          title: candidate.title,
          location: candidate.location,
          track: classifyTrack(candidate.title, profile),
          country: countryFromLocation(candidate.location, profile),
        }),
      );
    }
    return;
  }

  console.log(`\nseen ${sweep.candidates.length} · boards failed ${sweep.failures.length}`);
  console.log(`classified ${sweep.candidates.length - totalUnclassified} · unclassified ${totalUnclassified}`);
  for (const [track, n] of [...classified.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${track}: ${n}`);
  }
  // Named from the profile, not hardcoded "NL/IN": Tashi's profile targets NL
  // only, and printing a market she is not screened for would misreport the
  // discard as a filter she does not have.
  const markets = profile.targetCountries.map((c) => c.code).join("/");
  console.log(`  (of classified, ${offMarket} were outside ${markets})`);

  // The number the lane is actually judged on, printed rather than left as an
  // arithmetic exercise. "classified 715" and "660 outside NL" are two facts that
  // only mean something subtracted, and a metric a reader has to compute is a
  // metric that gets quoted wrong — 2026-09-07, this lane's real figure was 55
  // while the visible one said 715.
  console.log(`\nIN-MARKET ON-TRACK: ${sweep.candidates.length - totalUnclassified - offMarket} postings in ${markets}`);

  console.log(`\n── top 120 unclassified titles ──`);
  for (const [title, n] of ranked.slice(0, 120)) {
    console.log(`${String(n).padStart(4)}  ${title}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
