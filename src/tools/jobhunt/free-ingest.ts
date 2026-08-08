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
import { findApplicationByDedupeKey } from "../../db/job-queries.js";
import type { RawPosting } from "./ats-source.js";
import { FREE_PRICING } from "./cost.js";
import { countryFromLocation } from "./country.js";
import { dedupeKey } from "./filters.js";
import { getFreeBoards, type FreeBoard } from "./free-boards.js";
import { toRawPosting, type FreeCandidate } from "./free-ats-mappers.js";
import { hydrateDescriptions, sweepBoards } from "./free-ats-source.js";
import { screenBatch, type IngestLine } from "./ingest-batch.js";
import { recordQueryCost } from "./ingest-ledger.js";
import { classifyTrack } from "./tracks.js";

const log = childLogger({ module: "jobhunt:free-ingest" });

/**
 * How far back a posting may have been published and still be a candidate.
 *
 * Deliberately much wider than the 30-minute polling interval. The window is the
 * lane's tolerance for its own downtime: at six hours a deploy, a restart or a
 * host outage lasting most of a morning costs nothing, because the next sweep
 * still sees everything published while the lane was dark. Narrowing it to match
 * the interval would make every missed sweep a permanent hole, and a permanent
 * hole in a feed nobody is invoicing is invisible.
 *
 * The overlap it creates is free: a posting seen in an earlier sweep is already
 * in the tracker and is dropped before it costs a body fetch.
 */
/**
 * How far back a posting may have been published and still be a candidate.
 * Default: 720h (30 days) to drain standing inventory once. Deduplication is
 * handled by keepUnseen (tracker lookup), while age bounds relevance.
 */
export const FREE_LANE_MAX_AGE_HOURS = Number(process.env["FREE_LANE_MAX_AGE_HOURS"] ?? 720);

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
): FilterOutcome {
  let undated = 0;
  let stale = 0;
  let offTrack = 0;
  let offMarket = 0;

  const kept = candidates.filter((candidate) => {
    if (candidate.postedAt === null) {
      undated += 1;
      return false;
    }
    if (hoursSince(candidate.postedAt, now) > maxAgeHours) {
      stale += 1;
      return false;
    }
    if (classifyTrack(candidate.title) === null) {
      offTrack += 1;
      return false;
    }
    // `unknown` stays: a remote posting frequently states no country, and
    // discarding those would drop the most reachable roles on the board.
    if (countryFromLocation(candidate.location) === "other") {
      offMarket += 1;
      return false;
    }
    return true;
  });

  const notes: string[] = [];
  if (stale > 0) notes.push(`${stale} postings older than ${maxAgeHours}h — seen in an earlier sweep`);
  if (offTrack > 0) notes.push(`${offTrack} postings were not an engineering track`);
  if (offMarket > 0) notes.push(`${offMarket} postings were outside the Netherlands and India`);
  if (undated > 0) notes.push(`${undated} postings stated no publication date and were skipped`);

  return { kept, notes, counts: { undated, stale, offTrack, offMarket } };
}

/**
 * Drop candidates the tracker has already stored.
 *
 * THIS LANE IS A FIRST-SEEN DETECTOR. Re-screening a posting it already caught
 * buys nothing and costs a body fetch against a third-party host every thirty
 * minutes — and refreshing verdicts on known rows is already the metered sweep's
 * job. Keeping it here would be the same work done twice, less well.
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

  const postings: RawPosting[] = [];
  let bodyless = 0;
  for (const candidate of hydrated) {
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
  if (known > 0) notes.push(`${known} postings were already in the tracker`);
  if (bodyless > 0) notes.push(`${bodyless} postings had no readable description and were skipped`);

  const funnel: FreeFunnel = {
    seen: sweep.candidates.length,
    undated: filtered.counts.undated,
    stale: filtered.counts.stale,
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
    ...(sweep.failures.length > 0 ? { error: sweep.failures.slice(0, 3).join("; ") } : {}),
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
