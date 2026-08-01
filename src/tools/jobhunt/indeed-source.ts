/**
 * FounderOS — Indeed job source
 * =============================
 * The BREADTH source. The ATS feed reads ~175k company career sites directly and
 * is the higher-trust supply; Indeed is an aggregator, so it sees roles that
 * never reach an ATS the feed covers — but it also carries agency reposts,
 * duplicates of ATS jobs, and ghost postings that were filled weeks ago.
 *
 * The two are therefore NOT merged into one undifferentiated stream. Every row
 * records which feed produced it, and an Indeed-only row does not reach the
 * brief's DO TODAY list without passing liveness verification (liveness.ts).
 *
 * Actor: `kaix/indeed-scraper`, $0.00005/job ($0.06 per 1,000) across 54
 * countries including NL and IN. At 30/day it costs ~$0.05/month, so cost played
 * no part in this choice — coverage did.
 *
 * TWO CONSTRAINTS THE ACTOR IMPOSES, both load-bearing:
 *   · `fromDays` cannot be combined with the `remote` filter. Remote queries
 *     therefore sort by date and bound recency on our side.
 *   · `basic` search mode returns less body text than `detailed`. The salary and
 *     language gates parse the body, so a truncated description does not degrade
 *     them — it makes them confidently wrong about evidence that was never
 *     fetched. We request `detailed` and DROP anything still too short.
 */

import { childLogger } from "../../infra/logger.js";
import { runActorSync } from "../apify.js";
import {
  mapIndeedItems,
  readJobKeyStatuses,
  type IndeedPosting,
  type JobKeyStatus,
} from "./indeed-mappers.js";
import { TRACK_PRIORITY, TRACK_TITLES, type RoleTrack } from "./tracks.js";

// Re-exported so every existing import site keeps resolving here. The pure
// mappers moved to indeed-mappers.ts on 2026-08-01 when this file crossed its
// size budget; nothing about their behaviour moved with them.
export {
  mapIndeedItems,
  readJobKeyStatuses,
  MIN_DESCRIPTION_CHARS,
  INDEED_SOURCE,
} from "./indeed-mappers.js";
export type { IndeedPosting, JobKeyStatus, MappedIndeed } from "./indeed-mappers.js";

const log = childLogger({ module: "jobhunt:indeed-source" });

/** Apify uses `~` instead of `/` in REST paths. */
export const INDEED_ACTOR = "kaix~indeed-scraper";

/** Well under Apify's 300s sync ceiling, which returns HTTP 408 beyond it. */
const INDEED_TIMEOUT_MS = 280_000;

/** Indeed country codes the campaign uses. NL for pool B, IN for pool C. */
export type IndeedCountry = "NL" | "IN";

export interface IndeedQuery {
  readonly country: IndeedCountry;
  readonly tracks?: readonly RoleTrack[];
  readonly limit?: number;
  /** "remote" | "hybrid" — cannot be combined with `fromDays` (actor constraint). */
  readonly remote?: "remote" | "hybrid";
  /** Drop postings older than this. Applied by us, not by the actor. */
  readonly maxAgeDays?: number;
  readonly location?: string;
}

export type IndeedFetch =
  | {
      readonly ok: true;
      readonly postings: readonly IndeedPosting[];
      /** Rows dropped for an unusably short body — reported, never hidden. */
      readonly droppedThin: number;
      /** Rows whose shape we could not read — the schema-drift alarm. */
      readonly droppedUnmappable: number;
      /** Rows the actor flagged as closed. A legitimate filter, reported not hidden. */
      readonly droppedExpired: number;
      /** Rows older than `maxAgeDays`. Also legitimate, also reported. */
      readonly droppedStale: number;
    }
  | { readonly ok: false; readonly error: string };

/**
 * Build Indeed's advanced-search string from the campaign's track titles.
 *
 * `title:("A" or "B")` restricts matching to the TITLE. Indeed's plain keyword
 * search is broad by design and would return "Sales Engineer" for "AI Engineer",
 * which then spends the day's budget on postings no gate can salvage.
 */
export function buildKeywordQuery(tracks: readonly RoleTrack[] = TRACK_PRIORITY): string {
  const ordered = TRACK_PRIORITY.filter((t) => tracks.includes(t));
  const phrases = [
    ...new Set(ordered.flatMap((t) => TRACK_TITLES[t].map((p) => p.replace(/:\*$/, "")))),
  ];
  if (phrases.length === 0) return "";
  const titles = phrases.map((p) => `"${p}"`).join(" or ");
  // Internships cannot carry any of the three permit bases, so excluding them at
  // source is not a preference — it is removing rows that are void by definition.
  return `title:(${titles}) -intern -internship -stage`;
}

/**
 * Build the actor input. Pure, so the daily sweep, a manual run and the tests
 * all produce byte-identical input for the same query.
 */
export function buildIndeedInput(query: IndeedQuery): Record<string, unknown> {
  return {
    keyword: buildKeywordQuery(query.tracks),
    country: query.country,
    ...(query.location ? { location: query.location } : {}),
    maxItems: query.limit ?? 20,
    // `detailed` over `basic`: the gates need the body, not a teaser.
    searchMode: "detailed",
    // Date order is not cosmetic here. `fromDays` is unavailable whenever the
    // remote filter is set, so recency has to come from the sort plus a
    // client-side age cut — otherwise a remote query returns 2024 postings.
    sort: "date",
    ...(query.remote ? { remote: query.remote } : {}),
    proxyConfig: { useApifyProxy: true },
  };
}

/** Look up specific postings by job key — the liveness path, not a search. */
export function buildJobKeyInput(jobKeys: readonly string[]): Record<string, unknown> {
  return {
    jobKeys: [...jobKeys],
    country: "NL",
    searchMode: "basic",
    proxyConfig: { useApifyProxy: true },
  };
}

// ── Network ───────────────────────────────────────────────────────────────────

/** Run the search and map its dataset. Never throws. */
export async function fetchIndeedPostings(query: IndeedQuery): Promise<IndeedFetch> {
  const input = buildIndeedInput(query);
  const run = await runActorSync(INDEED_ACTOR, input, INDEED_TIMEOUT_MS);
  if (!run.ok) {
    log.warn({ error: run.error, country: query.country }, "Indeed fetch failed");
    return { ok: false, error: run.error };
  }

  const mapped = mapIndeedItems(run.items, {
    ...(query.maxAgeDays !== undefined ? { maxAgeDays: query.maxAgeDays } : {}),
    // The country code we just queried IS the country. `IndeedCountry` is a
    // subset of `PostingCountry` on purpose, so this needs no translation table
    // that could drift.
    country: query.country,
  });
  log.info(
    {
      country: query.country,
      returned: run.items.length,
      usable: mapped.postings.length,
      droppedThin: mapped.droppedThin,
      droppedUnmappable: mapped.droppedUnmappable,
      droppedExpired: mapped.droppedExpired,
      droppedStale: mapped.droppedStale,
    },
    "Indeed fetch complete",
  );
  return {
    ok: true,
    postings: mapped.postings,
    droppedThin: mapped.droppedThin,
    droppedUnmappable: mapped.droppedUnmappable,
    droppedExpired: mapped.droppedExpired,
    droppedStale: mapped.droppedStale,
  };
}

/**
 * Look up job keys and read back each one's `expired` flag.
 *
 * A key the lookup does not return at all is `unverifiable`, NOT `expired`.
 * Indeed omitting a row and Indeed saying the job is closed look identical from
 * here, and only one of those readings is safe to act on: marking a live role
 * dead removes it from the brief and emits no signal that it did.
 */
export async function lookupJobKeys(
  jobKeys: readonly string[],
): Promise<Map<string, JobKeyStatus>> {
  const result = new Map<string, JobKeyStatus>();
  if (jobKeys.length === 0) return result;

  const run = await runActorSync(INDEED_ACTOR, buildJobKeyInput(jobKeys), INDEED_TIMEOUT_MS);
  if (!run.ok) {
    log.warn({ error: run.error, count: jobKeys.length }, "Indeed liveness lookup failed");
    for (const key of jobKeys) result.set(key, "unverifiable");
    return result;
  }

  for (const [key, status] of readJobKeyStatuses(run.items)) result.set(key, status);
  for (const key of jobKeys) {
    if (!result.has(key)) result.set(key, "unverifiable");
  }
  return result;
}
