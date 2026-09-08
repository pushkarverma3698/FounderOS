/**
 * FounderOS — not paying twice for a board that has not changed
 * =============================================================
 * A bounded in-process ETag cache for the free-board sweep.
 *
 * WHY THIS EXISTS. The sweep re-asks every board for its whole list every thirty
 * minutes, and a board changes maybe once a day. Every other poll is therefore a
 * full payload we already hold, paid for in bandwidth at a third party that is
 * doing us a favour by serving it unauthenticated.
 *
 * It stops being a nicety the moment a platform inlines bodies. Personio's `/xml`
 * is the whole board including every job description — 2.26 MB for one board
 * measured live on 2026-08-22. Across the ~78 IND-sponsor Personio boards that is
 * roughly 156 MB every half hour unconditionally, which is the exact figure that
 * kept Personio out of the registry (see free-boards.ts). Personio serves an
 * `ETag` and honours `If-None-Match` with a 0-byte 304 (verified live, same
 * date), so the steady-state cost of the same sweep is a few hundred bytes per
 * unchanged board. This module is what turns the first number into the second.
 *
 * ONLY BOARD LISTS. Per-posting body URLs are fetched once and essentially never
 * re-asked, so caching them would grow the map for no hit rate.
 */

/** Bounded because the registry grows: 858 boards today, and nothing prunes it. */
const DEFAULT_MAX_ENTRIES = 2_000;

interface CacheEntry {
  readonly etag: string;
  readonly payload: unknown;
}

import { getAtsCache, setAtsCache } from "../../db/ats-board-cache-queries.js";

export interface EtagCache {
  /**
   * The conditional-request headers for this URL — `{}` when there is nothing
   * to revalidate against.
   */
  headersFor(url: string): Promise<Record<string, string>>;
  /** The payload a 304 refers to, or undefined when we no longer hold it. */
  read(url: string): Promise<unknown>;
  /** Remember a 200. A response with no ETag is simply not stored. */
  store(url: string, etag: string | null | undefined, payload: unknown): Promise<void>;
}

export function createEtagCache(): EtagCache {
  return {
    async headersFor(url: string): Promise<Record<string, string>> {
      try {
        const hit = await getAtsCache(url);
        return hit && hit.etag ? { "if-none-match": hit.etag } : {};
      } catch (err) {
        // allow-failopen: fallback to uncached request if cache DB fails
        return {};
      }
    },

    async read(url: string): Promise<unknown> {
      try {
        const hit = await getAtsCache(url);
        return hit?.payload;
      } catch (err) {
        // allow-failopen: fallback to cache miss if cache DB fails
        return undefined;
      }
    },

    async store(url: string, etag: string | null | undefined, payload: unknown): Promise<void> {
      try {
        await setAtsCache(url, etag, payload);
      } catch (err) {
        // allow-failopen: skip caching if cache DB fails
      }
    },
  };
}

