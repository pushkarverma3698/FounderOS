/**
 * FounderOS — ingest_jobs tool + daily sweep
 * ==========================================
 * Fetch postings from the ATS feed and run every one through the SAME gates the
 * founder's manual paste goes through (`screenPosting`). No second
 * implementation of any gate lives here — that drift would be invisible,
 * because both paths would keep returning confident verdicts.
 *
 * Zero model spend: fetch is HTTP, gates are pure code, the summary is a
 * template. The daily sweep can therefore run unattended without touching the
 * LLM budget at all.
 *
 * A low number is a FINDING, not a fault. Netherlands + recognised sponsor +
 * 2–5 years + AI/backend is a narrow slice, and the count this produces is the
 * first honest measurement of a market the campaign doc has been estimating.
 *
 * NOTHING FETCHED IS DISCARDED (founder direction, 2026-08-01: "store all the
 * data we are collecting even if it is senior and of no use to us"). Early-career
 * postings used to be dropped here, before screening, so they never reached the
 * table and the founder could not audit what had been thrown away on his behalf
 * — a filter and an empty market look identical from outside. They are a GATE
 * now (experience.ts): every posting that arrives is screened, stored, and
 * appears in the brief with the reason it will not be applied to. The only thing
 * still filtered before it costs money is `titleExclusionSearch` at the feed,
 * where a posting is never fetched and so cannot be stored either way.
 */

import { randomUUID } from "node:crypto";
import { childLogger } from "../../infra/logger.js";
import {
  fetchAtsPostings,
  MIN_ATS_LIMIT,
  POOL_ORDER,
  POOL_QUERIES,
  type RawPosting,
} from "./ats-source.js";
import { fetchIndeedPostings, type IndeedCountry } from "./indeed-source.js";
import { TRACK_PRIORITY, TRACK_TITLES, type RoleTrack } from "./tracks.js";
import { screenPosting } from "./screen.js";
import { recordQueryCost } from "./ingest-ledger.js";
import { ATS_PRICING, INDEED_PRICING } from "./cost.js";

const log = childLogger({ module: "tool:ingest_jobs" });

/** Provenance stamped on every row this path creates. */
export const INGEST_SOURCE = "ats-ingest";

/**
 * NL for the remote-with-a-Dutch-office pool; IN for the remote-contract pool.
 *
 * Deliberately not US or global: a US company hiring a contractor in India is
 * income, not a step toward the Netherlands (founder decision, 2026-07-31), and
 * mixing the two would blur what the campaign is actually measuring.
 */
const INDEED_COUNTRIES: readonly IndeedCountry[] = ["NL", "IN"];

/** The actor cannot apply `fromDays` alongside its remote filter, so we cut here. */
const INDEED_MAX_AGE_DAYS = 3;

export interface IngestLine {
  readonly company: string;
  readonly title: string;
  readonly outcome: "pass" | "flag" | "reject" | "duplicate" | "error";
  readonly detail: string;
}

export interface IngestSummary {
  readonly fetched: number;
  readonly lines: readonly IngestLine[];
}

export type IngestResult =
  | { readonly ok: true; readonly summary: IngestSummary }
  | { readonly ok: false; readonly error: string };

/**
 * Screen a batch of already-fetched postings.
 *
 * Split out from the fetch so the batch behaviour is unit-testable without a
 * network call, and so a caller with postings from anywhere else can reuse it.
 *
 * One posting that blows up does NOT abort the batch. Losing nine good
 * screenings because the tenth had a malformed body would be the pipeline
 * failing at exactly the moment it is supposed to be unattended.
 */
export async function screenBatch(postings: readonly RawPosting[]): Promise<IngestLine[]> {
  const lines: IngestLine[] = [];

  for (const posting of postings) {
    try {
      const outcome = await screenPosting({
        company: posting.company,
        title: posting.title,
        description: posting.description,
        ...(posting.url ? { url: posting.url } : {}),
        ...(posting.postedAt ? { postedAt: posting.postedAt } : {}),
        // The posting's OWN provenance, not this module's. An Indeed row screened
        // through here must not be recorded as an ATS row: liveness verification
        // reads that field to decide which check to run.
        source: posting.source ?? INGEST_SOURCE,
        ...(posting.externalId ? { externalId: posting.externalId } : {}),
      });

      if (outcome.kind === "error") {
        lines.push({
          company: posting.company,
          title: posting.title,
          outcome: "error",
          detail: outcome.message,
        });
      } else if (outcome.kind === "duplicate") {
        lines.push({
          company: posting.company,
          title: posting.title,
          outcome: "duplicate",
          detail: `already in pipeline at stage "${outcome.stage}"`,
        });
      } else {
        lines.push({
          company: outcome.company,
          title: outcome.title,
          outcome: outcome.verdict.status,
          detail: outcome.verdict.reasons[0] ?? outcome.route,
        });
      }
    } catch (err) {
      lines.push({
        company: posting.company,
        title: posting.title,
        outcome: "error",
        detail: (err as Error).message,
      });
    }
  }

  return lines;
}

export interface PooledIngest {
  readonly fetched: number;
  readonly lines: readonly IngestLine[];
  /** One entry per source that failed. An outage must read as an outage. */
  readonly failures: readonly string[];
  /** Postings fetched per track. A track at 0 is a finding, not a silence. */
  readonly perTrack: Readonly<Record<RoleTrack, number>>;
  /** Groups this sweep's rows in `job_ingest_runs`, so a day's cost is one query. */
  readonly sweepId: string;
}

/**
 * Sweep every source pool, then screen everything they returned.
 *
 * PER-POOL ISOLATION is the point. One pool failing does not abort the sweep —
 * losing the Netherlands on-site pool because Indeed timed out would be the
 * pipeline failing at exactly the moment it is unattended, and it would fail
 * quietly, reporting a thin market rather than a broken run.
 *
 * The budget is split evenly across pools rather than spent first-come. Pool A
 * returns the most rows, so a shared pool would consume the whole allowance
 * before the remote-contract pools were reached — which is the coverage hole
 * this design exists to close.
 *
 * `opts.limit` is a TOTAL across the ATS queries, not a per-query figure, and it
 * cannot bind below `queries × MIN_ATS_LIMIT` — the actor rejects a limit under
 * 10, so that floor wins whenever the total is smaller. A caller passing 30
 * across 8 queries gets 10 each and fetches up to 80, not 30. Every query's real
 * cost is written to `job_ingest_runs` rather than inferred from this number.
 */
export async function runPooledIngest(opts: {
  limit: number;
  includeIndeed?: boolean;
}): Promise<PooledIngest> {
  const sweepId = randomUUID();
  const queries = POOL_ORDER.length * TRACK_PRIORITY.length;
  const perQuery = Math.max(MIN_ATS_LIMIT, Math.floor(opts.limit / queries));
  const lines: IngestLine[] = [];
  const failures: string[] = [];
  let fetched = 0;
  // Derived from TRACK_PRIORITY rather than written out, so adding a track can
  // never leave a counter silently missing — which would report that track as
  // "0 postings" forever regardless of what the feed actually returned.
  const perTrack = Object.fromEntries(TRACK_PRIORITY.map((t) => [t, 0])) as Record<
    RoleTrack,
    number
  >;

  // EVERY TRACK GETS ITS OWN QUERY AND ITS OWN BUDGET.
  //
  // Until 2026-08-01 all twelve title phrases went into ONE `titleSearch` with
  // ONE budget, AI first in the array. Nothing reserved supply for the others, so
  // whichever titles the feed happened to match first spent the whole allowance —
  // and frontend, the deepest track on the CV, came back empty. That was a
  // property of the request, not of the Dutch market, and it was invisible: an
  // empty track and an unasked track produce the same silence.
  //
  // Splitting by track costs one actor run per (pool × track) instead of per
  // pool. That is the price of coverage being a guarantee rather than luck —
  // and merging the two Netherlands pools on 2026-08-01 brought it back down
  // from 12 runs a sweep to 8 without giving any of that coverage up.
  //
  // SCREENED PER QUERY, not in one pooled batch at the end. Screening where the
  // fetch happened is what lets each query's cost sit next to the verdicts it
  // bought in `job_ingest_runs` — "we spent $0.13 on frontend and every row was
  // rejected on the level bar" is an actionable sentence, and it is unavailable
  // once the postings have been tipped into a shared array.
  for (const pool of POOL_ORDER) {
    for (const track of TRACK_PRIORITY) {
      const result = await fetchAtsPostings({
        ...POOL_QUERIES[pool],
        titles: TRACK_TITLES[track],
        timeRange: "24h",
        limit: perQuery,
      });

      if (!result.ok) {
        failures.push(`ATS pool "${pool}" / ${track}: ${result.error}`);
        // Billed a start regardless of what came back — recorded, or the cost of
        // a broken day would read as cheaper than a working one.
        await recordQueryCost({
          sweepId,
          feed: "ats",
          pool,
          track,
          requested: perQuery,
          returned: 0,
          pricing: ATS_PRICING,
          error: result.error,
        });
        continue;
      }

      perTrack[track] += result.postings.length;
      fetched += result.postings.length;
      const batch = result.postings.map((p) => ({ ...p, source: INGEST_SOURCE }));
      const batchLines = await screenBatch(batch);
      lines.push(...batchLines);
      await recordQueryCost({
        sweepId,
        feed: "ats",
        pool,
        track,
        requested: perQuery,
        returned: result.postings.length,
        pricing: ATS_PRICING,
        lines: batchLines,
      });
    }
  }

  if (opts.includeIndeed) {
    for (const country of INDEED_COUNTRIES) {
      const result = await fetchIndeedPostings({
        country,
        limit: perQuery,
        remote: "remote",
        maxAgeDays: INDEED_MAX_AGE_DAYS,
      });
      if (!result.ok) {
        failures.push(`Indeed ${country}: ${result.error}`);
        await recordQueryCost({
          sweepId,
          feed: "indeed",
          pool: country,
          track: "all",
          requested: perQuery,
          returned: 0,
          pricing: INDEED_PRICING,
          error: result.error,
        });
        continue;
      }
      if (result.droppedThin > 0) {
        // Reported, not hidden. These are dropped by the Indeed mapper before we
        // ever see them; a body too short to screen produces a verdict from
        // evidence that was never fetched, and a silent drop looks exactly like
        // a thin market. Anything that DOES reach the gates with a thin body is
        // stored and flagged by the `Posting` gate rather than dropped.
        failures.push(
          `Indeed ${country}: ${result.droppedThin} posting(s) dropped — body too short to screen.`,
        );
      }
      if (result.droppedUnmappable > 0) {
        // The 2026-07-31 alarm: 10 rows returned, 0 readable, and the sweep
        // reported success. An unreadable row means the actor's output shape
        // changed, which is our bug to fix — not evidence of an empty market.
        failures.push(
          `Indeed ${country}: ${result.droppedUnmappable} row(s) UNREADABLE — the actor's ` +
            "output shape does not match the mapper. This is a schema drift, not a quiet market.",
        );
      }
      fetched += result.postings.length;
      const batchLines = await screenBatch(result.postings);
      lines.push(...batchLines);
      await recordQueryCost({
        sweepId,
        feed: "indeed",
        pool: country,
        track: "all",
        requested: perQuery,
        returned: result.postings.length,
        pricing: INDEED_PRICING,
        lines: batchLines,
      });
    }
  }

  // A track that fetched nothing is reported. Zero rows for frontend used to be
  // indistinguishable from never having asked for frontend.
  for (const track of TRACK_PRIORITY) {
    if (perTrack[track] === 0) {
      failures.push(`Track "${track}": 0 postings across all ${POOL_ORDER.length} pools.`);
    }
  }

  log.info(
    { sweepId, fetched, perTrack, pools: POOL_ORDER.length, failures: failures.length },
    "Pooled job ingest complete",
  );
  return { fetched, lines, failures, perTrack, sweepId };
}
