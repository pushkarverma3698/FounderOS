/**
 * FounderOS — filling in what a board's list payload withheld
 * ===========================================================
 * Some platforms answer the list endpoint with a summary and keep the rest for a
 * per-posting detail fetch. This is where that second fetch happens, and where
 * the three fields it can supply — body, publication date, location — are merged
 * back onto the candidate.
 *
 * Split out of `free-ats-source.ts` on 2026-09-08, when the location merge pushed
 * that file past the 400-line CI budget (`scripts/verify-architecture.ts`,
 * loc-budget). Same precedent as free-ats-transport.ts and free-ingest-filters.ts;
 * the module it came from re-exports the names, so no import site changed.
 *
 * THE SEAM IS "WHAT ONE MORE REQUEST BUYS". free-ats-source.ts decides which
 * boards to poll and how hard; this file decides what a posting is still missing
 * and whether asking again is worth it.
 */

import { childLogger } from "../../infra/logger.js";
import { mapWithConcurrencyLimit } from "../../core/concurrency.js";
import { fetchJson } from "./free-ats-transport.js";
import { getAdapter } from "./adapters/index.js";
import type { AtsAdapter, NormalizedJob as FreeCandidate } from "./adapters/types.js";
import { mergeDetailLocation } from "./free-ingest-filters.js";
import { AGGREGATOR_TOKEN_PREFIX } from "./aggregator-source.js";

const log = childLogger({ module: "jobhunt:free-ats" });

/** One Greenhouse posting's body. Small payload, so a tighter bound. */
export const DESCRIPTION_TIMEOUT_MS = 10_000;

/** How many detail fetches to run at once. Matches the board sweep's default. */
export const HYDRATE_CONCURRENCY = 8;

/**
 * The candidate's location, with whatever the detail payload knows merged in.
 *
 * Exported for its own test, because this is the whole of the 2026-09-08 defect
 * in one expression: the detail payload we already downloaded carried
 * `location: "Paris"` and `country: {descriptor: "France"}` while the candidate
 * carried an empty string, and the empty string won all the way to the brief.
 *
 * The country NAME is appended rather than mapped to a code here on purpose —
 * `country.ts` owns the name→code decision and is the only place that should, so
 * this stays a string operation and the existing `countryFromLocation` does the
 * judging exactly as it already does for every other platform.
 */
export function applyDetailLocation(
  candidate: FreeCandidate,
  adapter: AtsAdapter,
  payload: Record<string, unknown>,
): string {
  return mergeDetailLocation(
    candidate.location,
    adapter.locationFromDetail?.(payload) ?? null,
    adapter.countryFromDetail?.(payload) ?? null,
  );
}

/**
 * Fill in the bodies (and dates, and locations) the list payload withheld.
 *
 * Candidates that already have a description (Lever, Ashby) pass through
 * untouched and cost nothing. A body that cannot be fetched leaves the candidate
 * with `description: null`, and the caller drops it with a reason — screening a
 * posting on an empty body would read as "this employer stated no requirements",
 * which every gate would then wave through.
 */
export async function hydrateDescriptions(
  candidates: readonly FreeCandidate[],
): Promise<FreeCandidate[]> {
  return mapWithConcurrencyLimit(candidates, HYDRATE_CONCURRENCY, async (candidate) => {
    if (candidate.description !== null) return candidate;
    // An aggregator's synthetic board carries a placeholder `ats`, so hydrating
    // it would fetch a Greenhouse URL built from a token no Greenhouse board has.
    // aggregator-source.ts asserts these never need hydration; this is what makes
    // that true rather than merely stated.
    if (candidate.board.token.startsWith(AGGREGATOR_TOKEN_PREFIX)) return candidate;

    const adapter = getAdapter(candidate.board.ats);
    if (!adapter) return candidate;

    const url = adapter.getJobUrl(candidate.board, candidate.externalId);
    // Null means the platform inlines its bodies, so a null description here is
    // a posting that genuinely has none — not one we failed to fetch.
    if (url === null) return candidate;

    try {
      const payload = (await fetchJson(url, DESCRIPTION_TIMEOUT_MS)) as Record<string, unknown>;
      // For a `dateOnlyInDetail` platform this is the FIRST point at which the
      // posting's real publication date exists. Everything before it treated the
      // date as unknown rather than as absent, deliberately.
      const postedAt = adapter.postedAtFromDetail?.(payload) ?? candidate.postedAt;
      // Same argument, one field over: for a tenant that leaves `locationsText`
      // empty this is the first point at which the posting's market exists.
      const location = applyDetailLocation(candidate, adapter, payload);
      return { ...candidate, postedAt, location, description: adapter.extractBody(payload) || null };
    } catch (err) {
      log.warn(
        { board: candidate.board.token, id: candidate.externalId, err: (err as Error).message },
        "Could not fetch posting body",
      );
      return candidate;
    }
  });
}
