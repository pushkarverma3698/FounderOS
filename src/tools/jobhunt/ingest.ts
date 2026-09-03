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
  POOL_COUNTRY,
  POOL_ORDER,
  POOL_QUERIES,
  type RawPosting,
} from "./ats-source.js";
import { fetchIndeedPostings, type IndeedCountry } from "./indeed-source.js";
import { TRACK_PRIORITY, TRACK_TITLES, type RoleTrack } from "./tracks.js";
import { dedupePostings, screenBatch, INGEST_SOURCE, type IngestLine } from "./ingest-batch.js";
import { recordQueryCost } from "./ingest-ledger.js";
import { ATS_PRICING, INDEED_PRICING, estimateQueryCost } from "./cost.js";
import { startBoardHarvest, collectBoardTokens, flushBoardHarvest, type DiscoveredBoard } from "./board-harvest.js";
import { checkSweepBudget } from "./spend-gate.js";

// Re-exported so every existing import site keeps resolving here. The batch
// screening moved to ingest-batch.ts on 2026-08-01 when this file crossed its
// size budget; nothing about its behaviour moved with it.
export { dedupePostings, screenBatch, INGEST_SOURCE } from "./ingest-batch.js";
export type { IngestLine, IngestSummary, IngestResult } from "./ingest-batch.js";

const log = childLogger({ module: "tool:ingest_jobs" });

/**
 * NL for the remote-with-a-Dutch-office pool; IN for the remote-contract pool.
 *
 * Deliberately not US or global: a US company hiring a contractor in India is
 * income, not a step toward the Netherlands (founder decision, 2026-07-31), and
 * mixing the two would blur what the campaign is actually measuring.
 */
const INDEED_COUNTRIES: readonly IndeedCountry[] = ["NL", "IN"];

/**
 * Whether each country's Indeed query is restricted to remote roles.
 *
 * NL stays remote-only: a Dutch on-site role is already covered by the ATS
 * `netherlands` pool, and what Indeed adds there is the remote-contract channel.
 *
 * IN IS DELIBERATELY UNRESTRICTED, and this is a correction. Until 2026-08-01
 * both countries were pinned to `remote: "remote"`, so every on-site and hybrid
 * role in Bangalore, Hyderabad, Pune, NCR and Mumbai was unreachable — not
 * rejected, never asked for. He LIVES in India; on-site there is not a
 * compromise, it is most of the market. An unasked market and an empty one
 * produce the same zero, which is the failure direction this codebase treats as
 * the expensive one.
 */
const INDEED_REMOTE: Record<IndeedCountry, "remote" | undefined> = {
  NL: "remote",
  IN: undefined,
};

/** The actor cannot apply `fromDays` alongside its remote filter, so we cut here. */
const INDEED_MAX_AGE_DAYS = 3;

export interface PooledIngest {
  readonly fetched: number;
  /**
   * Of everything fetched, how many the tracker had never seen.
   *
   * `fetched` is what the feed BILLED for; this is what it bought. On
   * 2026-08-02 the two were 32 and 0 — the sweep paid full price to re-screen
   * the previous sweep, and every number the pipeline reported went up anyway.
   */
  readonly fresh: number;
  readonly lines: readonly IngestLine[];
  /** One entry per source that failed. An outage must read as an outage. */
  readonly failures: readonly string[];
  /**
   * Rows a feed filtered out on purpose, with the reason and the count.
   *
   * SEPARATE FROM `failures`, and that separation is the fix. Expired postings
   * and duplicates used to leave through unreported code paths, so the live NL
   * sweep logged "returned 10, usable 2" with nothing accounting for the other
   * eight — making "the market is thin", "eight were stale listings" and "the
   * mapper is broken" three readings of one number. Filtering is correct;
   * filtering invisibly is not, and putting these under the INCOMPLETE RUN
   * heading would have been the opposite error: a working day reading as a
   * broken one.
   */
  readonly notes: readonly string[];
  /** Postings fetched per track. A track at 0 is a finding, not a silence. */
  readonly perTrack: Readonly<Record<RoleTrack, number>>;
  /** Groups this sweep's rows in `job_ingest_runs`, so a day's cost is one query. */
  readonly sweepId: string;
  readonly newBoards: readonly DiscoveredBoard[]; // new registry rows — see board-harvest.ts
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
  const notes: string[] = [];
  let fetched = 0;

  // WHAT THIS SWEEP WILL COST, BEFORE SPENDING ANY OF IT.
  //
  // The posting limit has never been the real budget. `perQuery` cannot go below
  // MIN_ATS_LIMIT because the actor rejects a smaller one, so a caller asking for
  // 80 across 12 queries gets 10 each and buys up to 120 — the declared limit
  // silently stops binding the moment the query count grows. The cap that binds
  // is denominated in dollars, checked here, because dollars are what runs out.
  const indeedQueries = opts.includeIndeed ? INDEED_COUNTRIES.length : 0;
  const projectedUsd =
    queries * estimateQueryCost(ATS_PRICING, perQuery) +
    indeedQueries * estimateQueryCost(INDEED_PRICING, perQuery);

  const budget = await checkSweepBudget(projectedUsd);
  if (!budget.ok) {
    // Refused LOUDLY and reported as a failure, so a skipped sweep reaches the
    // brief. Quietly declining to spend would be a cheaper rerun of the failure
    // this pipeline already had: a system that stops producing without saying so.
    log.warn({ sweepId, ...budget }, "Sweep refused by the spend cap");
    return {
      fetched: 0,
      fresh: 0,
      lines: [],
      failures: [budget.reason],
      notes: [],
      perTrack: Object.fromEntries(TRACK_PRIORITY.map((t) => [t, 0])) as Record<RoleTrack, number>,
      sweepId,
      newBoards: [],
    };
  }

  if (queries * MIN_ATS_LIMIT > opts.limit) {
    // Said out loud rather than left as a surprise on the invoice.
    notes.push(
      `Requested limit ${opts.limit} cannot bind: ${queries} ATS queries × the actor's ` +
        `${MIN_ATS_LIMIT}-job floor means up to ${queries * MIN_ATS_LIMIT} postings. ` +
        `The spend cap (${budget.reason}) is what actually limits this sweep.`,
    );
  }
  // Derived from TRACK_PRIORITY rather than written out, so adding a track can
  // never leave a counter silently missing — which would report that track as
  // "0 postings" forever regardless of what the feed actually returned.
  const perTrack = Object.fromEntries(TRACK_PRIORITY.map((t) => [t, 0])) as Record<
    RoleTrack,
    number
  >;

  const harvest = startBoardHarvest(sweepId); // see board-harvest.ts
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

      perTrack[track] = (perTrack[track] ?? 0) + result.postings.length;
      fetched += result.postings.length;
      // The row's OWN location wins; the pool's country is the fallback for a
      // posting the feed gave no location for. A "netherlands" query can return
      // a role listed in Belgium, and the specific answer beats the query's.
      const batch = result.postings.map((p) => ({
        ...p,
        source: INGEST_SOURCE,
        country: (p.country && p.country !== "unknown" ? p.country : POOL_COUNTRY[pool] ?? "unknown") as any,
      }));
      collectBoardTokens(harvest, batch); // fetch boundary, before dedupe/screening
      const { unique, collapsed } = dedupePostings(batch);
      if (collapsed > 0) {
        notes.push(
          `ATS ${pool}/${track}: ${collapsed} repeat listing(s) collapsed — the feed returned ` +
            `the same role more than once. Billed for, screened once.`,
        );
      }
      const batchLines = await screenBatch(unique);
      lines.push(...batchLines);
      await recordQueryCost({
        sweepId,
        feed: "ats",
        pool,
        track,
        requested: perQuery,
        // `returned` is what we were BILLED for; the lines below are what we
        // actually screened. Keeping both is what makes cost-per-useful-posting
        // answerable rather than estimated.
        returned: result.postings.length,
        pricing: ATS_PRICING,
        lines: batchLines,
      });
    }
  }

  if (opts.includeIndeed) {
    for (const country of INDEED_COUNTRIES) {
      const remote = INDEED_REMOTE[country];
      const result = await fetchIndeedPostings({
        country,
        limit: perQuery,
        ...(remote ? { remote } : {}),
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
      // Legitimate filters, now COUNTED. They used to leave through bare
      // `continue`s, so a run that returned 10 rows and screened 2 gave no
      // account of the other 8 — and "the market is thin" was indistinguishable
      // from "the mapper broke". Reported as notes, not failures: a day that
      // correctly skipped eight dead listings is a working day.
      if (result.droppedExpired > 0) {
        notes.push(
          `Indeed ${country}: ${result.droppedExpired} listing(s) skipped — the employer has ` +
            `already closed them.`,
        );
      }
      if (result.droppedStale > 0) {
        notes.push(
          `Indeed ${country}: ${result.droppedStale} listing(s) skipped — older than ` +
            `${INDEED_MAX_AGE_DAYS} days.`,
        );
      }
      fetched += result.postings.length;
      const { unique, collapsed } = dedupePostings(result.postings);
      if (collapsed > 0) {
        notes.push(
          `Indeed ${country}: ${collapsed} repeat listing(s) collapsed — the same role was ` +
            `returned more than once. Billed for, screened once.`,
        );
      }
      const batchLines = await screenBatch(unique);
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

  // Postings that arrived and then failed the gates are an OUTAGE, and until
  // 2026-08-05 nothing said so: `failures` was fed only by fetch errors, so when
  // the sponsor register stopped resolving in the built output and every posting
  // came back `kind: "error"`, four consecutive sweeps reported a quiet market.
  // A rejection is the gates working and is deliberately not counted here.
  const errored = lines.filter((l) => l.outcome === "error");
  if (errored.length > 0) {
    const cause = errored[0]!.detail || "no reason recorded";
    const scope = errored.length === lines.length ? "EVERY posting" : `${errored.length} posting(s)`;
    failures.push(
      `${scope} failed to screen (${errored.length}/${lines.length}). ` +
        `This is the gates failing, not a thin market. First cause: ${cause}`,
    );
  }

  const fresh = lines.filter((l) => l.isNew).length;
  const newBoards = await flushBoardHarvest(harvest, sweepId);

  log.info(
    {
      sweepId,
      fetched,
      fresh,
      perTrack,
      pools: POOL_ORDER.length,
      failures: failures.length,
      notes: notes.length,
      newBoardsDiscovered: newBoards.length,
    },
    "Pooled job ingest complete",
  );
  return { fetched, fresh, lines, failures, notes, perTrack, sweepId, newBoards };
}
