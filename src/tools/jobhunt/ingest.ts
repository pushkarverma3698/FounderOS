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
 */

import { childLogger } from "../../infra/logger.js";
import {
  fetchAtsPostings,
  MIN_ATS_LIMIT,
  POOL_ORDER,
  POOL_QUERIES,
  type AtsQuery,
  type RawPosting,
} from "./ats-source.js";
import { fetchIndeedPostings, type IndeedCountry } from "./indeed-source.js";
import { excludeEarlyCareer } from "./seniority.js";
import { TRACK_PRIORITY, TRACK_TITLES, type RoleTrack } from "./tracks.js";
import { screenPosting } from "./screen.js";
import { formatIngestSummary } from "./ingest-format.js";
import type { UnifiedTool, ToolResult } from "../index.js";

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
  /** Early-career postings dropped before screening. Counted, never silent. */
  readonly droppedEarlyCareer: number;
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
 */
export async function runPooledIngest(opts: {
  limit: number;
  includeIndeed?: boolean;
}): Promise<PooledIngest> {
  const queries = POOL_ORDER.length * TRACK_PRIORITY.length;
  const perQuery = Math.max(MIN_ATS_LIMIT, Math.floor(opts.limit / queries));
  const postings: RawPosting[] = [];
  const failures: string[] = [];
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
  // pool. That is the price of coverage being a guarantee rather than luck.
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
        continue;
      }
      perTrack[track] += result.postings.length;
      postings.push(...result.postings.map((p) => ({ ...p, source: INGEST_SOURCE })));
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
        continue;
      }
      if (result.droppedThin > 0) {
        // Reported, not hidden. A body too short to screen produces a verdict
        // from evidence that was never fetched, so these are dropped — but a
        // silent drop looks exactly like a thin market.
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
      postings.push(...result.postings);
    }
  }

  // Internships and graduate schemes are removed HERE, after the count that
  // proves the feed answered, so a thin day is never confused with a filtered
  // one. On 2026-08-01 four of the eight live rows were intern/graduate/junior
  // postings that the substring title match had swept in.
  const seniority = excludeEarlyCareer(postings);
  if (seniority.dropped > 0) {
    failures.push(
      `Dropped ${seniority.dropped} early-career posting(s) (intern / graduate / working student): ` +
        seniority.droppedTitles.slice(0, 5).join("; "),
    );
  }

  // A track that fetched nothing is reported. Zero rows for frontend used to be
  // indistinguishable from never having asked for frontend.
  for (const track of TRACK_PRIORITY) {
    if (perTrack[track] === 0) {
      failures.push(`Track "${track}": 0 postings across all ${POOL_ORDER.length} pools.`);
    }
  }

  const lines = await screenBatch(seniority.kept);
  log.info(
    {
      fetched: seniority.kept.length,
      perTrack,
      droppedEarlyCareer: seniority.dropped,
      pools: POOL_ORDER.length,
      failures: failures.length,
    },
    "Pooled job ingest complete",
  );
  return {
    fetched: seniority.kept.length,
    lines,
    failures,
    perTrack,
    droppedEarlyCareer: seniority.dropped,
  };
}

/** Fetch → screen → summarise. The whole pipeline in one call. */
export async function runJobIngest(query: AtsQuery = {}): Promise<IngestResult> {
  const fetched = await fetchAtsPostings(query);
  if (!fetched.ok) return { ok: false, error: fetched.error };

  const lines = await screenBatch(fetched.postings);
  log.info(
    {
      fetched: fetched.postings.length,
      pass: lines.filter((l) => l.outcome === "pass").length,
      reject: lines.filter((l) => l.outcome === "reject").length,
    },
    "Job ingest complete",
  );
  return { ok: true, summary: { fetched: fetched.postings.length, lines } };
}

// ── Tool ──────────────────────────────────────────────────────────────────────

export const ingestJobsTool: UnifiedTool = {
  name: "ingest_jobs",
  description:
    "Pull fresh job postings from the ATS feed (~50 platforms: Greenhouse, Lever, " +
    "Workday, Personio, Recruitee…) and screen every one against the hard legal " +
    "gates automatically. This is how postings ENTER the pipeline — use it when the " +
    "founder asks to find, refresh, or sweep for new jobs. Returns a verdict " +
    "breakdown, not a list of links. Read-mostly, no approval needed, no model spend.",
  input_schema: {
    type: "object",
    properties: {
      limit: {
        type: "number",
        description: "Postings to pull (minimum 10, which is also the daily budget).",
      },
      time_range: {
        type: "string",
        description: "How far back to look: 1h, 24h, 7d, or 6m. Defaults to 24h.",
      },
      titles: {
        type: "array",
        description:
          "Array of title phrases to search, e.g. ['AI Engineer:*']. ':*' is a prefix wildcard. " +
          "Omit to use the campaign's default target roles.",
      },
      locations: {
        type: "array",
        description:
          "Array of exact 'City, Region, Country' phrases or a bare country, English names only " +
          "(e.g. 'Amsterdam, North Holland, Netherlands'). Defaults to the Netherlands.",
      },
      organizations: {
        type: "array",
        description:
          "Array of employer names to restrict to — this is how the IND recognised-sponsor " +
          "register is used as a target list rather than only as a filter.",
      },
    },
    required: [],
  },

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const timeRange = args["time_range"];
    const query: AtsQuery = {
      ...(typeof args["limit"] === "number" ? { limit: args["limit"] } : {}),
      ...(timeRange === "1h" || timeRange === "24h" || timeRange === "7d" || timeRange === "6m"
        ? { timeRange }
        : {}),
      ...(Array.isArray(args["titles"]) ? { titles: args["titles"] as string[] } : {}),
      ...(Array.isArray(args["locations"]) ? { locations: args["locations"] as string[] } : {}),
      ...(Array.isArray(args["organizations"])
        ? { organizations: args["organizations"] as string[] }
        : {}),
    };

    const result = await runJobIngest(query);
    if (!result.ok) {
      return {
        success: false,
        error:
          `Job ingest failed: ${result.error}\n` +
          "No postings were screened. Nothing was recorded — there is deliberately no " +
          "fallback to web search, because a search snippet through the salary gate " +
          "produces a confident verdict from evidence that was never fetched.",
      };
    }
    return { success: true, data: formatIngestSummary(result.summary) };
  },
};
