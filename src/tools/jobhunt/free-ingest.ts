/**
 * FounderOS — the free lane's sweep
 * =================================
 * Poll every board, keep what is new and relevant, screen it through the gates
 * the metered feed already uses, and record the run at a cost of zero.
 *
 * THE ONE THING THIS LANE DOES THAT THE OTHER CANNOT. The metered feed is billed
 * per job returned, so it must decide what it wants BEFORE it asks — narrow title
 * queries, capped at ten results each, every third day. This lane asks for the
 * whole board and decides afterwards, for nothing. Its median lag from a posting
 * going live to us holding it is the polling interval, against 19.6 hours for the
 * metered feed (measured 2026-08-06). That gap is the product.
 *
 * FILTERING BEFORE SCREENING, AND WHY THAT IS NOT THE THING THE FOUNDER BANNED.
 * The standing rule is that a posting must be rejected INSIDE the pipeline, where
 * the reason is stored and shown, never dropped outside it where a filtered-out
 * row and an empty market look identical. That rule is about VERDICTS — about
 * roles we could have applied to. It is not a requirement to run the sponsor
 * register and the salary parser over every warehouse and concept-artist vacancy
 * on 238 boards, forty-eight times a day.
 *
 * So this lane filters on three cheap, local facts before screening — is it
 * recent, is it an engineering track, is it in a market we can work in — and
 * every one of those filters RETURNS ITS COUNT, which the caller reports as
 * notes. "1,412 postings were not an engineering track" is a sentence about the
 * boards; a silent drop would be a sentence about nothing.
 *
 * COLD START is handled by the freshness window, not by the tracker. The first
 * sweep of a 238-board registry sees roughly 16,000 live postings, and treating
 * every one of them as new would flood the brief on day one and bury the handful
 * that actually matter. Only postings published inside the window are candidates,
 * so the first run behaves exactly like every later one.
 */

import { randomUUID } from "node:crypto";
import { childLogger } from "../../infra/logger.js";
import { mapWithConcurrencyLimit } from "../../core/concurrency.js";
import { intEnv } from "../../core/config.js";
import { findApplicationByDedupeKey } from "../../db/job-queries.js";
import { getProfile, type JobSearchProfile } from "./profile-config.js";
import type { RawPosting } from "./ats-source.js";
import { FREE_PRICING } from "./cost.js";
import { countryFromLocation } from "./country.js";
import { dedupeKey } from "./filters.js";
import { getFreeBoards, type FreeBoard } from "./free-boards.js";
import {
  hydrateDescriptions,
  sweepBoards,
  summariseFailures,
  type FreeCandidate,
} from "./free-ats-source.js";
import { getAdapter } from "./adapters/index.js";
import { screenBatch, type IngestLine } from "./ingest-batch.js";
import { recordQueryCost } from "./ingest-ledger.js";
import { classifyTrack } from "./tracks.js";

const log = childLogger({ module: "jobhunt:free-ingest" });

export const FREE_INGEST_SOURCE = "free-ats-ingest";

export function toRawPosting(candidate: FreeCandidate, description: string): RawPosting {
  return {
    company: candidate.board.name,
    title: candidate.title,
    url: candidate.url,
    description,
    location: candidate.location,
    postedAt: candidate.postedAt,
    source: FREE_INGEST_SOURCE,
    externalId: candidate.externalId,
    country: countryFromLocation(candidate.location),
  };
}

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

/** Bound on the tracker lookups. Small queries, but not worth 400 at once. */
const LOOKUP_CONCURRENCY = 12;

export interface FreeFunnel {
  readonly seen: number;
  readonly undated: number;
  readonly stale: number;
  readonly offTrack: number;
  readonly offMarket: number;
  readonly known: number;
  readonly bodyless: number;
  readonly screened: number;
}

export interface FreeIngestResult {
  /** Postings the boards returned, before any filter. */
  readonly seen: number;
  /** Postings that survived every filter and reached the gates. */
  readonly screened: number;
  readonly lines: readonly IngestLine[];
  /** One entry per board that failed. An outage must read as an outage. */
  readonly failures: readonly string[];
  /** What was filtered and why, with counts. Never silent. */
  readonly notes: readonly string[];
  readonly boardsPolled: number;
  readonly sweepId: string;
  /** Structured per-stage funnel summary. */
  readonly funnel: FreeFunnel;
}

function hoursSince(date: Date, now: Date): number {
  return (now.getTime() - date.getTime()) / 3_600_000;
}

interface FilterOutcome {
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
    if (classifyTrack(candidate.title) === null) {
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
  if (stale > 0) notes.push(`${stale} postings older than ${maxAgeHours}h — not screened`);
  if (offTrack > 0) {
    notes.push(
      profile.skillsDictionaryName === "tech"
        ? `${offTrack} postings were not an engineering track`
        : `${offTrack} postings were not in a target track`,
    );
  }
  if (offMarket > 0) {
    if (profile.id === "pushkar-nl-tech") {
      notes.push(`${offMarket} postings were outside the Netherlands and India`);
    } else {
      const marketList = profile.targetCountries.map((c) => c.names[0] ?? c.code).join(", ");
      notes.push(`${offMarket} postings were outside target markets (${marketList})`);
    }
  }
  if (undated > 0) notes.push(`${undated} postings stated no publication date and were skipped`);

  return { kept, notes, counts: { undated, stale, offTrack, offMarket } };
}

/**
 * Drop candidates the tracker has already stored.
 */
async function keepUnseen(
  candidates: readonly FreeCandidate[],
): Promise<{ unseen: FreeCandidate[]; known: number }> {
  const withinBatch = new Set<string>();
  const deduped = candidates.filter((candidate) => {
    const key = dedupeKey(candidate.board.name, candidate.title);
    if (withinBatch.has(key)) return false;
    withinBatch.add(key);
    return true;
  });

  const flags = await mapWithConcurrencyLimit(deduped, LOOKUP_CONCURRENCY, async (candidate) => {
    const existing = await findApplicationByDedupeKey(
      dedupeKey(candidate.board.name, candidate.title),
    );
    return existing !== null;
  });

  const unseen = deduped.filter((_, i) => flags[i] === false);
  return { unseen, known: candidates.length - unseen.length };
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

/**
 * Run one free sweep.
 *
 * `boards` is injectable so a test can drive the whole path over two boards
 * without reading the registry, and so a manual run can poll one board.
 */
export async function runFreeIngest(
  opts: {
    readonly boards?: readonly FreeBoard[];
    readonly now?: Date;
    readonly maxAgeHours?: number;
  } = {},
): Promise<FreeIngestResult> {
  const now = opts.now ?? new Date();
  const sweepId = randomUUID();
  const boards = opts.boards ?? getFreeBoards();

  const sweep = await sweepBoards(boards);
  const filtered = filterCandidates(sweep.candidates, now, opts.maxAgeHours);
  const { unseen, known } = await keepUnseen(filtered.kept);
  const hydrated = await hydrateDescriptions(unseen);
  const maxAgeHours = opts.maxAgeHours ?? FREE_LANE_MAX_AGE_HOURS;
  const deferred = applyDeferredFreshness(hydrated, now, maxAgeHours);

  const postings: RawPosting[] = [];
  let bodyless = 0;
  for (const candidate of deferred.kept) {
    if (candidate.description === null || candidate.description.trim().length === 0) {
      // Screening an empty body would read as "this employer stated no
      // requirements", and every gate would wave it through on that basis.
      bodyless += 1;
      continue;
    }
    postings.push(toRawPosting(candidate, candidate.description));
  }

  const lines = await screenBatch(postings);

  const notes = [...filtered.notes];
  if (deferred.stale > 0) {
    notes.push(
      `${deferred.stale} postings older than ${maxAgeHours}h — not screened (date resolved after fetch)`,
    );
  }
  if (deferred.undated > 0) {
    notes.push(`${deferred.undated} postings had no publication date even after fetch — skipped`);
  }
  if (known > 0) notes.push(`${known} postings were already in the tracker`);
  if (bodyless > 0) notes.push(`${bodyless} postings had no readable description and were skipped`);

  const funnel: FreeFunnel = {
    seen: sweep.candidates.length,
    // Each reason has ONE true total regardless of which stage caught it: most
    // platforms resolve undated/stale before hydration, dateOnlyInDetail
    // platforms resolve it after. See applyDeferredFreshness.
    undated: filtered.counts.undated + deferred.undated,
    stale: filtered.counts.stale + deferred.stale,
    offTrack: filtered.counts.offTrack,
    offMarket: filtered.counts.offMarket,
    known,
    bodyless,
    screened: postings.length,
  };

  // RECORDED EVEN THOUGH IT IS FREE, and recorded as zero rather than omitted. A
  // lane that writes no ledger row is indistinguishable from a lane that did not
  // run, and this one runs unattended forty-eight times a day.
  await recordQueryCost({
    sweepId,
    feed: "free-ats",
    pool: "free-boards",
    track: "all",
    requested: sweep.candidates.length,
    returned: postings.length,
    pricing: FREE_PRICING,
    lines,
    // The funnel goes to the DATABASE now, not only to journalctl. It was built
    // here and dropped at the ledger boundary until 2026-08-21, which is why
    // "are we dropping roles?" needed a log regex on the production box to
    // answer — and why nobody had noticed that `stale` was discarding 24,446
    // never-seen postings a sweep.
    funnel: {
      seen: funnel.seen,
      undated: funnel.undated,
      stale: funnel.stale,
      offTrack: funnel.offTrack,
      offMarket: funnel.offMarket,
      known: funnel.known,
      bodyless: funnel.bodyless,
    },
    // Counts per (platform, reason), NOT the first three strings. The sweep polls
    // Greenhouse first, so "first three" was always the same three harmless 404s
    // and 36 Recruitee rate limits a sweep never reached the founder — the
    // reporting half of the defect `free-ats-source.ts` describes as its fourth
    // failure rule.
    ...(sweep.failures.length > 0 ? { error: summariseFailures(sweep.failures) } : {}),
  });

  log.info(
    {
      funnel,
      boards: boards.length,
      seen: sweep.candidates.length,
      screened: postings.length,
      failed: sweep.failures.length,
    },
    "Free ingest complete",
  );

  return {
    seen: sweep.candidates.length,
    screened: postings.length,
    lines,
    failures: sweep.failures,
    notes,
    boardsPolled: sweep.boardsPolled,
    sweepId,
    funnel,
  };
}
