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
  filterCandidates,
  applyDeferredFreshness,
  summariseBodyless,
  FREE_LANE_MAX_AGE_HOURS,
} from "./free-ingest-filters.js";

// Re-exported so the operational scripts that already import these from here
// keep working. The filters moved out on 2026-09-04 for the 400-line budget;
// where they are DEFINED is an internal detail, and churning six call sites to
// announce it would be the refactor leaking into unrelated files.
export {
  filterCandidates,
  applyDeferredFreshness,
  summariseBodyless,
  bodylessCause,
  FREE_LANE_MAX_AGE_HOURS,
  type FilterOutcome,
} from "./free-ingest-filters.js";
import {
  hydrateDescriptions,
  sweepBoards,
  summariseFailures,
  type BoardSweep,
  type FreeCandidate,
} from "./free-ats-source.js";
import { getAdapter } from "./adapters/index.js";
import { screenBatch, type IngestLine } from "./ingest-batch.js";
import { recordQueryCost } from "./ingest-ledger.js";
import { classifyTrack } from "./tracks.js";

const log = childLogger({ module: "jobhunt:free-ingest" });

export const FREE_INGEST_SOURCE = "free-ats-ingest";

export function toRawPosting(
  candidate: FreeCandidate,
  description: string,
  profile: JobSearchProfile = getProfile(),
): RawPosting {
  return {
    company: candidate.board.name,
    title: candidate.title,
    url: candidate.url,
    description,
    location: candidate.location,
    postedAt: candidate.postedAt,
    source: FREE_INGEST_SOURCE,
    externalId: candidate.externalId,
    country: countryFromLocation(candidate.location, profile),
  };
}


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
  profile: JobSearchProfile = getProfile(),
): Promise<{ unseen: FreeCandidate[]; known: number }> {
  const withinBatch = new Set<string>();
  const deduped = candidates.filter((candidate) => {
    const key = dedupeKey(candidate.board.name, candidate.title);
    if (withinBatch.has(key)) return false;
    withinBatch.add(key);
    return true;
  });

  // SCOPED TO THIS CANDIDATE. Unscoped, the first profile to screen a posting
  // marks it "already in the tracker" for every other profile, which starves the
  // second candidate's lane of exactly the roles the first one just rejected —
  // and does it silently, as a `known` count that looks like healthy dedupe.
  const flags = await mapWithConcurrencyLimit(deduped, LOOKUP_CONCURRENCY, async (candidate) => {
    const existing = await findApplicationByDedupeKey(
      dedupeKey(candidate.board.name, candidate.title),
      profile.tenantId,
      profile.id,
    );
    return existing !== null;
  });

  const unseen = deduped.filter((_, i) => flags[i] === false);
  return { unseen, known: candidates.length - unseen.length };
}

/**
 * Run one free sweep, for ONE profile.
 *
 * `boards` is injectable so a test can drive the whole path over two boards
 * without reading the registry, and so a manual run can poll one board.
 *
 * `sweep` is injectable for a different reason: polling 1,297 boards is the
 * expensive half of this lane, and its result does not depend on which candidate
 * is being screened. `runFreeSweep` polls once and hands the same `BoardSweep` to
 * every profile, so adding a second candidate costs body fetches for the roles
 * that candidate's own filters keep — not a second pass over the registry.
 */
export async function runFreeIngest(
  opts: {
    readonly boards?: readonly FreeBoard[];
    readonly now?: Date;
    readonly maxAgeHours?: number;
    readonly profile?: JobSearchProfile;
    readonly sweep?: BoardSweep;
  } = {},
): Promise<FreeIngestResult> {
  const now = opts.now ?? new Date();
  const sweepId = randomUUID();
  const profile = opts.profile ?? getProfile();
  // The registry is read ONLY when this call has to poll for itself. Reading it
  // eagerly makes a caller that already holds a sweep depend on a file it never
  // uses — and `getFreeBoards()` throws on a thin registry by design, so that
  // dependency could fail a screening run that needed no boards at all.
  const sweep = opts.sweep ?? (await sweepBoards(opts.boards ?? getFreeBoards()));
  const filtered = filterCandidates(sweep.candidates, now, opts.maxAgeHours, profile);
  const { unseen, known } = await keepUnseen(filtered.kept, profile);
  const hydrated = await hydrateDescriptions(unseen);
  const maxAgeHours = opts.maxAgeHours ?? FREE_LANE_MAX_AGE_HOURS;
  const deferred = applyDeferredFreshness(hydrated, now, maxAgeHours);

  const postings: RawPosting[] = [];
  // The dropped CANDIDATES, not a counter. A count cannot say which platform
  // lost them, and this gate quietly ate 100% of the lane's output for thirty
  // hours on 2026-09-06 while reporting the number 7.
  const bodylessDropped: FreeCandidate[] = [];
  for (const candidate of deferred.kept) {
    if (candidate.description === null || candidate.description.trim().length === 0) {
      // Screening an empty body would read as "this employer stated no
      // requirements", and every gate would wave it through on that basis.
      bodylessDropped.push(candidate);
      continue;
    }
    postings.push(toRawPosting(candidate, candidate.description, profile));
  }
  const bodyless = bodylessDropped.length;

  const lines = await screenBatch(postings, profile);

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
  const bodylessNote = summariseBodyless(bodylessDropped);
  if (bodylessNote !== null) {
    notes.push(bodylessNote);
    // WARN, not info. Every posting that reached this gate had already passed
    // freshness, track, market and the tracker — it is one of the handful of
    // roles the whole sweep exists to find, and losing it is never routine.
    log.warn(
      { profile: profile.id, bodyless, detail: bodylessNote },
      "Postings reached screening with no body and were dropped",
    );
  }

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
      // WHAT WAS POLLED, not what is on file. Since the sweep became injectable
      // (one poll shared by every profile) the registry size and the poll size
      // are different numbers, and `runFreeSweep` always injects — so logging
      // the registry here reported 1,297 boards on a run that polled 8.
      boards: sweep.boardsPolled,
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
