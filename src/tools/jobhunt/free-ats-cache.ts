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

export interface EtagCache {
  /**
   * The conditional-request headers for this URL — `{}` when there is nothing
   * to revalidate against.
   */
  headersFor(url: string): Record<string, string>;
  /** The payload a 304 refers to, or undefined when we no longer hold it. */
  read(url: string): unknown;
  /** Remember a 200. A response with no ETag is simply not stored. */
  store(url: string, etag: string | null | undefined, payload: unknown): void;
  readonly size: number;
}

/**
 * An ETag cache that never claims a revalidation it cannot honour.
 *
 * THE BUG THIS SHAPE AVOIDS. Sending `If-None-Match` for an entry whose payload
 * has been evicted earns a 304 with no body and nothing to fall back on — the
 * board silently contributes zero candidates and looks like an employer with no
 * openings. So the header and the payload come from the same entry: if the entry
 * is gone, no header is sent and the fetch is unconditional. A cache miss must
 * cost bandwidth, never correctness.
 *
 * Eviction is oldest-first insertion order, which is what `Map` already gives us.
 * Not LRU: every board is polled on the same fixed cycle, so recency carries no
 * information here that insertion order does not.
 */
export function createEtagCache(maxEntries: number = DEFAULT_MAX_ENTRIES): EtagCache {
  const entries = new Map<string, CacheEntry>();

  return {
    headersFor(url: string): Record<string, string> {
      const hit = entries.get(url);
      return hit ? { "if-none-match": hit.etag } : {};
    },

    read(url: string): unknown {
      return entries.get(url)?.payload;
    },

    store(url: string, etag: string | null | undefined, payload: unknown): void {
      // No ETag means no revalidation is possible. Storing the payload anyway
      // would build a map we can never get a 304 against.
      if (typeof etag !== "string" || etag.length === 0) {
        entries.delete(url);
        return;
      }
      // Re-insert so a refreshed entry moves to the back of the eviction order
      // rather than keeping its original position.
      entries.delete(url);
      entries.set(url, { etag, payload });

      while (entries.size > maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done === true) break;
        entries.delete(oldest.value);
      }
    },

    get size(): number {
      return entries.size;
    },
  };
}
