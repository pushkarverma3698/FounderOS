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
 * So this lane filters on two cheap, local facts before screening — is it an
 * engineering track, is it in a market we can work in — and every one of those
 * filters RETURNS ITS COUNT, which the caller reports as notes AND logs as
 * numbers. "1,412 postings were not an engineering track" is a sentence about
 * the boards; a silent drop would be a sentence about nothing.
 *
 * THERE IS NO FRESHNESS WINDOW, AND THE ONE THAT USED TO BE HERE IS WHY THIS
 * LANE PRODUCED NOTHING (fixed 2026-08-09). A six-hour publication window sat in
 * front of these filters on the theory that it bounded the lane's own downtime.
 * Measured against 60 live boards it discarded everything: of 8,621 candidates
 * the YOUNGEST was 10.3 hours old and the median was 62 days, so the window kept
 * zero — as did 24h. Across 64 production sweeps that is 1,306,522 postings
 * fetched and not one screened, while the log line said "Free ingest complete".
 * Boards do not republish on our polling interval, and `first_published` is the
 * original publication date, not a heartbeat.
 *
 * COLD START and re-screening are handled by `keepUnseen` — the tracker — which
 * is the honest form of the question the window was pretending to ask. "Have we
 * already got this one?" is answered by what we stored, never by a clock.
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

/** Bound on the tracker lookups. Small queries, but not worth 400 at once. */
const LOOKUP_CONCURRENCY = 12;

export interface FreeIngestResult {
  /** Postings the boards returned, before any filter. */
  readonly seen: number;
  /** Postings that survived every filter and reached the gates. */
  readonly screened: number;
  /** Per-filter tallies, so a caller can tell WHICH stage emptied the funnel. */
  readonly counts: FilterCounts;
  readonly lines: readonly IngestLine[];
  /** One entry per board that failed. An outage must read as an outage. */
  readonly failures: readonly string[];
  /** What was filtered and why, with counts. Never silent. */
  readonly notes: readonly string[];
  readonly boardsPolled: number;
  readonly sweepId: string;
}

/**
 * Per-filter tallies for the log line.
 *
 * ALWAYS PRESENT, INCLUDING THE ZEROES — unlike `notes`, which are suppressed at
 * zero so the founder never reads "0 postings were …". A filter missing from the
 * log is indistinguishable from a filter that dropped nothing, and that exact
 * ambiguity is what let a lane discarding 100% of its input log
 * "Free ingest complete" 64 times without anyone noticing.
 */
export interface FilterCounts {
  readonly seen: number;
  readonly offTrack: number;
  readonly offMarket: number;
  readonly kept: number;
}

interface FilterOutcome {
  readonly kept: readonly FreeCandidate[];
  readonly notes: readonly string[];
  readonly counts: FilterCounts;
}

/**
 * The two cheap filters, applied in order and each one counted.
 *
 * Pure and time-independent. Age is deliberately NOT consulted: whether we have
 * seen a posting before is the tracker's question (`keepUnseen`), and a posting's
 * publication date says nothing about whether we already hold it. An undated
 * posting is therefore kept — with no age gate there is nothing for a missing
 * date to fail.
 */
export function filterCandidates(candidates: readonly FreeCandidate[]): FilterOutcome {
  let offTrack = 0;
  let offMarket = 0;

  const kept = candidates.filter((candidate) => {
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
  if (offTrack > 0) notes.push(`${offTrack} postings were not an engineering track`);
  if (offMarket > 0) notes.push(`${offMarket} postings were outside the Netherlands and India`);

  return {
    kept,
    notes,
    counts: { seen: candidates.length, offTrack, offMarket, kept: kept.length },
  };
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
  } = {},
): Promise<FreeIngestResult> {
  const sweepId = randomUUID();
  const boards = opts.boards ?? getFreeBoards();

  const sweep = await sweepBoards(boards);
  const filtered = filterCandidates(sweep.candidates);
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

  // THE FUNNEL IS LOGGED IN FULL, one field per stage, every run. The previous
  // line carried only seen/screened/failed, so a lane dropping 100% of its input
  // at a filter looked exactly like a lane finding nothing on a quiet morning.
  // Whichever number collapses to zero, the field above it now names the stage
  // that did it.
  log.info(
    {
      boards: boards.length,
      seen: filtered.counts.seen,
      offTrack: filtered.counts.offTrack,
      offMarket: filtered.counts.offMarket,
      relevant: filtered.counts.kept,
      alreadyTracked: known,
      unseen: unseen.length,
      bodyless,
      screened: postings.length,
      failed: sweep.failures.length,
    },
    "Free ingest complete",
  );

  return {
    seen: sweep.candidates.length,
    screened: postings.length,
    counts: filtered.counts,
    lines,
    failures: sweep.failures,
    notes,
    boardsPolled: sweep.boardsPolled,
    sweepId,
  };
}
