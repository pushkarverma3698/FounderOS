/**
 * FounderOS — the free lane's cheap pre-screening filters
 * =======================================================
 * The three local facts a posting is judged on before it costs a body fetch:
 * is it recent, is it one of THIS candidate's tracks, is it in a market they can
 * work in. Split out of free-ingest.ts on 2026-09-04 to keep that file inside the
 * 400-line CI budget once the filters became per-profile.
 *
 * Pure by construction — `now` is passed in, never read — so the freshness
 * boundary is testable to the hour without waiting for one. Every filter RETURNS
 * ITS COUNT: a silent drop makes a filtered-out row and an empty market look
 * identical, and that ambiguity has already cost this pipeline weeks.
 */

import { getProfile, type JobSearchProfile } from "./profile-config.js";
import { countryFromLocation } from "./country.js";
import { classifyTrack } from "./tracks.js";
import { getAdapter } from "./adapters/index.js";
import { intEnv } from "../../core/config.js";
import type { FreeCandidate } from "./free-ats-source.js";

/**
 * How far back a posting may have been published and still be a candidate.
 * Default: 720h (30 days) to drain standing inventory once. Deduplication is
 * handled by keepUnseen (tracker lookup), while age bounds relevance.
 *
 * Deliberately much wider than the 30-minute polling interval. The window is the
 * lane's tolerance for its own downtime: a deploy, a restart or a host outage
 * costs nothing, because the next sweep still sees everything published while the
 * lane was dark. Narrowing it to match the interval would make every missed sweep
 * a permanent hole, and a permanent hole in a feed nobody is invoicing is
 * invisible. The overlap it creates is free: a posting seen in an earlier sweep
 * is already in the tracker and is dropped before it costs a body fetch.
 *
 * Parsed with intEnv, NOT `Number(process.env[...] ?? 720)`. `??` only catches
 * unset; a present-but-blank `FREE_LANE_MAX_AGE_HOURS=` in a .env parses to 0,
 * every posting becomes stale, and the lane silently returns to screening zero —
 * the exact defect this window was widened to fix. intEnv rejects 0, NaN and
 * negatives and falls back, so the failure direction is "too wide", never "dark".
 */
export const FREE_LANE_MAX_AGE_HOURS = intEnv("FREE_LANE_MAX_AGE_HOURS", 720);

/** "netherlands" → "the Netherlands" reads as a place; the raw key does not. */
function titleCase(value: string): string {
  return value.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

function hoursSince(date: Date, now: Date): number {
  return (now.getTime() - date.getTime()) / 3_600_000;
}

export interface FilterOutcome {
  readonly kept: readonly FreeCandidate[];
  readonly notes: readonly string[];
  readonly counts: {
    readonly undated: number;
    readonly stale: number;
    readonly offTrack: number;
    readonly offMarket: number;
  };
}

/**
 * The three cheap filters, applied in order and each one counted.
 *
 * Pure: a `now` is passed in rather than read, so the freshness boundary is
 * testable to the hour without waiting for one.
 *
 * An undated posting is DROPPED, not kept. Every one of these platforms states a
 * publication date, so a missing one means a malformed row — and treating unknown
 * age as fresh is exactly how a three-year-old listing reaches the top of a brief
 * that promised the founder new roles.
 */
export function filterCandidates(
  candidates: readonly FreeCandidate[],
  now: Date,
  maxAgeHours: number = FREE_LANE_MAX_AGE_HOURS,
  profile: JobSearchProfile = getProfile(),
): FilterOutcome {
  let undated = 0;
  let stale = 0;
  let offTrack = 0;
  let offMarket = 0;

  const kept = candidates.filter((candidate) => {
    // A `dateOnlyInDetail` platform (BambooHR) states no date on the list
    // payload by construction — see adapters/bamboohr.ts. Judging freshness here
    // would drop every one of its postings as `undated` before hydration ever
    // runs, which is exactly what makes those boards worth nothing. Its date
    // check is deferred to `applyDeferredFreshness`, once the detail fetch has
    // actually supplied one; track and market are still judged here, same as
    // every other platform.
    const deferDate = getAdapter(candidate.board.ats)?.dateOnlyInDetail === true;

    if (!deferDate) {
      const postedAt = candidate.postedAt;
      if (postedAt === null) {
        undated += 1;
        return false;
      }
      if (hoursSince(postedAt, now) > maxAgeHours) {
        stale += 1;
        return false;
      }
    }
    if (classifyTrack(candidate.title, profile) === null) {
      offTrack += 1;
      return false;
    }
    // `unknown` stays: a remote posting frequently states no country, and
    // discarding those would drop the most reachable roles on the board.
    if (countryFromLocation(candidate.location, profile) === "other") {
      offMarket += 1;
      return false;
    }
    return true;
  });

  const notes: string[] = [];
  // NOT "seen in an earlier sweep". That was the wording until 2026-08-21 and it
  // is a claim this function cannot make: it runs AHEAD of `keepUnseen` and has
  // no database knowledge at all. Production settled it — 554 rows in
  // `job_applications` lifetime against 24,446 dropped here every thirty
  // minutes, so at most 554 of them had ever been seen and the rest were open
  // roles nobody had ever looked at. A note that explains a drop away is worse
  // than no note, because it stops anyone asking what is behind the number.
  if (stale > 0) notes.push(`${stale} postings older than ${maxAgeHours}h — not screened`);
  // Named from the profile rather than branched on its id. A `profile.id ===
  // "pushkar-nl-tech"` special case reintroduces exactly the per-candidate
  // hardcoding this whole module was pulled apart to remove, and it makes the
  // second candidate's note the vaguer of the two for no reason.
  if (offTrack > 0) {
    const trackList = profile.trackPriority.join(", ");
    notes.push(`${offTrack} postings matched none of ${profile.candidateName}'s tracks (${trackList})`);
  }
  if (offMarket > 0) {
    const marketList = profile.targetCountries.map((c) => titleCase(c.names[0] ?? c.code)).join(" or ");
    notes.push(`${offMarket} postings were outside ${marketList}`);
  }
  if (undated > 0) notes.push(`${undated} postings stated no publication date and were skipped`);

  return { kept, notes, counts: { undated, stale, offTrack, offMarket } };
}

/**
 * The freshness check `filterCandidates` deferred for `dateOnlyInDetail`
 * platforms, run now that hydration has (maybe) supplied a real date.
 *
 * Counted into the SAME undated/stale reasons `filterCandidates` uses rather
 * than a new pair of buckets — a second, differently-named bucket for "dropped
 * for the same reason, just later" would be exactly the ambiguity this pipeline
 * has already lost weeks to, wearing a new label.
 */
export function applyDeferredFreshness(
  hydrated: readonly FreeCandidate[],
  now: Date,
  maxAgeHours: number,
): { kept: FreeCandidate[]; undated: number; stale: number } {
  let undated = 0;
  let stale = 0;

  const kept = hydrated.filter((candidate) => {
    if (getAdapter(candidate.board.ats)?.dateOnlyInDetail !== true) return true;

    if (candidate.postedAt === null) {
      undated += 1;
      return false;
    }
    if (hoursSince(candidate.postedAt, now) > maxAgeHours) {
      stale += 1;
      return false;
    }
    return true;
  });

  return { kept, undated, stale };
}
