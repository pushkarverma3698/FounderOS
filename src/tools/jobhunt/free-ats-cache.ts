/**
 * FounderOS — not paying twice for a board that has not changed
 * =============================================================
 * A bounded, persistent-ready conditional GET cache for the free-board sweep.
 *
 * Tracks ETag (If-None-Match) and Last-Modified (If-Modified-Since) validators,
 * payload hashes, failure counts, and timestamps.
 *
 * Survives restarts when paired with `src/db/ats-cache-queries.ts` so that 18
 * restarts in 3 days does not trigger 18 unconditional re-fetches of 1,300 boards.
 *
 * ONLY BOARD LISTS. Per-posting body URLs are fetched once and essentially never
 * re-asked, so caching them would grow the map for no hit rate.
 */

import { createHash } from "node:crypto";

/** Bounded because the registry grows: 1,300+ boards today. */
export const DEFAULT_MAX_ENTRIES = 2_000;

export interface CacheEntry {
  readonly etag?: string | null;
  readonly lastModified?: string | null;
  readonly payload: unknown;
  readonly payloadHash?: string | null;
  readonly status?: number | null;
  readonly failureCount?: number;
  readonly lastCheckedAt?: Date;
}

export interface BoardCacheRecord {
  readonly url: string;
  readonly etag?: string | null;
  readonly last_modified?: string | null;
  readonly payload_hash?: string | null;
  readonly payload?: string | null;
  readonly status?: number | null;
  readonly failure_count?: number;
  readonly last_checked_at?: Date;
}

export interface EtagCacheOptions {
  readonly maxEntries?: number;
  readonly onSave?: (params: {
    readonly url: string;
    readonly etag?: string | null;
    readonly lastModified?: string | null;
    readonly payloadHash?: string | null;
    readonly payload?: string | null;
    readonly status?: number | null;
    readonly failureCount?: number;
    readonly lastCheckedAt?: Date;
  }) => Promise<void> | void;
  readonly onTouch?: (url: string, status: number) => Promise<void> | void;
  readonly onFailure?: (url: string, status?: number) => Promise<void> | void;
}

export interface EtagCache {
  /**
   * The conditional-request headers for this URL — `{}` when there is nothing
   * to revalidate against.
   */
  headersFor(url: string): Record<string, string>;

  /** The payload a 304 refers to, or undefined when we no longer hold it. */
  read(url: string): unknown;

  /** Inspect the raw cache entry. */
  getEntry(url: string): CacheEntry | undefined;

  /** Remember a 200 response with validator(s). */
  store(url: string, etag: string | null | undefined, payload: unknown): void;
  store(
    url: string,
    etag: string | null | undefined,
    lastModifiedOrPayload: unknown,
    payload?: unknown,
    status?: number,
  ): void;

  /** Record a 304 Not Modified hit, updating timestamp and clearing failures. */
  touch(url: string, status?: number): void;

  /** Record a failure for this board, incrementing its failure count. */
  recordFailure(url: string, status?: number): void;

  /** Warm the in-memory cache from persistent DB records. */
  warmFromEntries(records: readonly BoardCacheRecord[]): void;

  readonly size: number;
}

/** Compute deterministic SHA-256 hash of a payload for drift tracking. */
export function hashPayload(payload: unknown): string {
  const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
  return createHash("sha256").update(raw).digest("hex");
}

/** Parse serialized payload from DB row back into memory representation. */
function parseStoredPayload(raw: string | null | undefined): unknown {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return raw;
    }
  }
  return raw;
}

/** Serialize payload for DB persistence. */
function serializePayload(payload: unknown): string | null {
  if (payload === null || payload === undefined) return null;
  return typeof payload === "string" ? payload : JSON.stringify(payload);
}

/**
 * An ETag/Last-Modified cache that never claims a revalidation it cannot honour.
 *
 * THE BUG THIS SHAPE AVOIDS. Sending `If-None-Match` or `If-Modified-Since` for
 * an entry whose payload has been evicted earns a 304 with no body and nothing
 * to fall back on — the board silently contributes zero candidates and looks
 * like an employer with no openings. So the header and the payload come from the
 * same entry: if the entry is gone, no header is sent and the fetch is
 * unconditional. A cache miss must cost bandwidth, never correctness.
 */
export function createEtagCache(optionsOrMax: number | EtagCacheOptions = DEFAULT_MAX_ENTRIES): EtagCache {
  const options: EtagCacheOptions =
    typeof optionsOrMax === "number" ? { maxEntries: optionsOrMax } : optionsOrMax;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const entries = new Map<string, CacheEntry>();

  return {
    headersFor(url: string): Record<string, string> {
      const hit = entries.get(url);
      if (!hit || hit.payload === undefined) return {};
      const headers: Record<string, string> = {};
      if (typeof hit.etag === "string" && hit.etag.length > 0) {
        headers["if-none-match"] = hit.etag;
      }
      if (typeof hit.lastModified === "string" && hit.lastModified.length > 0) {
        headers["if-modified-since"] = hit.lastModified;
      }
      return headers;
    },

    read(url: string): unknown {
      return entries.get(url)?.payload;
    },

    getEntry(url: string): CacheEntry | undefined {
      return entries.get(url);
    },

    store(
      url: string,
      etag: string | null | undefined,
      lastModifiedOrPayload: unknown,
      maybePayload?: unknown,
      maybeStatus?: number,
    ): void {
      let lastModified: string | null | undefined;
      let payload: unknown;
      let status = 200;

      if (maybePayload !== undefined) {
        lastModified = typeof lastModifiedOrPayload === "string" ? lastModifiedOrPayload : null;
        payload = maybePayload;
        status = maybeStatus ?? 200;
      } else {
        lastModified = null;
        payload = lastModifiedOrPayload;
      }

      const hasEtag = typeof etag === "string" && etag.length > 0;
      const hasLastModified = typeof lastModified === "string" && lastModified.length > 0;

      // Without at least one validator, no revalidation is possible.
      if (!hasEtag && !hasLastModified) {
        entries.delete(url);
        return;
      }

      const now = new Date();
      const payloadHash = payload !== undefined ? hashPayload(payload) : null;
      const entry: CacheEntry = {
        etag: hasEtag ? etag : null,
        lastModified: hasLastModified ? lastModified : null,
        payload,
        payloadHash,
        status,
        failureCount: 0,
        lastCheckedAt: now,
      };

      entries.delete(url);
      entries.set(url, entry);

      while (entries.size > maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done === true) break;
        entries.delete(oldest.value);
      }

      if (options.onSave) {
        try {
          void options.onSave({
            url,
            etag: entry.etag,
            lastModified: entry.lastModified,
            payloadHash: entry.payloadHash,
            payload: serializePayload(payload),
            status: entry.status,
            failureCount: 0,
            lastCheckedAt: now,
          });
        } catch {
          // allow-failopen: asynchronous persistence should never fail in-memory cache
        }
      }
    },

    touch(url: string, status: number = 304): void {
      const existing = entries.get(url);
      const now = new Date();
      if (existing) {
        entries.set(url, {
          ...existing,
          status,
          failureCount: 0,
          lastCheckedAt: now,
        });
      }
      if (options.onTouch) {
        try {
          void options.onTouch(url, status);
        } catch {
          // allow-failopen: async persistence hook
        }
      }
    },

    recordFailure(url: string, status?: number): void {
      const existing = entries.get(url);
      const now = new Date();
      if (existing) {
        entries.set(url, {
          ...existing,
          status: status ?? null,
          failureCount: (existing.failureCount ?? 0) + 1,
          lastCheckedAt: now,
        });
      }
      if (options.onFailure) {
        try {
          void options.onFailure(url, status);
        } catch {
          // allow-failopen: async persistence hook
        }
      }
    },

    warmFromEntries(records: readonly BoardCacheRecord[]): void {
      for (const rec of records) {
        if (!rec.url || !rec.payload) continue;
        const payload = parseStoredPayload(rec.payload);
        if (payload === undefined) continue;

        entries.set(rec.url, {
          etag: rec.etag ?? null,
          lastModified: rec.last_modified ?? null,
          payload,
          payloadHash: rec.payload_hash ?? null,
          status: rec.status ?? 200,
          failureCount: rec.failure_count ?? 0,
          lastCheckedAt: rec.last_checked_at ? new Date(rec.last_checked_at) : new Date(),
        });
      }
    },

    get size(): number {
      return entries.size;
    },
  };
}
