/**
 * FounderOS — ATS board cache persistence
 * =======================================
 * Durable store for conditional-request validators (ETag, Last-Modified)
 * and board payloads. Survives process restarts so the free-board sweep
 * does not unconditionally re-fetch ~1,300 boards on boot.
 */

import { eq, sql } from "drizzle-orm";
import { getDb } from "./client.js";
import { atsBoardCache, type AtsBoardCache } from "./schema.js";
import { childLogger } from "../infra/logger.js";

const log = childLogger({ module: "db:ats-cache" });

export interface SaveBoardCacheParams {
  readonly url: string;
  readonly etag?: string | null;
  readonly lastModified?: string | null;
  readonly payloadHash?: string | null;
  readonly payload?: string | null;
  readonly status?: number | null;
  readonly failureCount?: number;
  readonly lastCheckedAt?: Date;
}

/**
 * Load all stored board cache entries from Postgres to warm the in-memory cache.
 * Returns empty array if database is unreachable or table is empty.
 */
export async function loadBoardCacheEntries(): Promise<AtsBoardCache[]> {
  try {
    const db = getDb();
    return await db.select().from(atsBoardCache);
  } catch (err) {
    // allow-failopen: db unavailable in test environment or transient outage
    log.warn({ err: (err as Error).message }, "Could not load board cache from db");
    return [];
  }
}

/**
 * Load a single board cache entry by URL.
 */
export async function loadBoardCacheEntry(url: string): Promise<AtsBoardCache | null> {
  try {
    const db = getDb();
    const [row] = await db
      .select()
      .from(atsBoardCache)
      .where(eq(atsBoardCache.url, url))
      .limit(1);
    return row ?? null;
  } catch (err) {
    // allow-failopen: db unavailable in test environment
    log.warn({ err: (err as Error).message, url }, "Could not load board cache entry");
    return null;
  }
}

/**
 * Upsert a board cache record when a board returns HTTP 200 with new data.
 */
export async function saveBoardCacheEntry(params: SaveBoardCacheParams): Promise<void> {
  try {
    const db = getDb();
    const now = params.lastCheckedAt ?? new Date();
    await db
      .insert(atsBoardCache)
      .values({
        url: params.url,
        etag: params.etag ?? null,
        last_modified: params.lastModified ?? null,
        payload_hash: params.payloadHash ?? null,
        payload: params.payload ?? null,
        status: params.status ?? 200,
        failure_count: params.failureCount ?? 0,
        last_checked_at: now,
        updated_at: now,
      })
      .onConflictDoUpdate({
        target: atsBoardCache.url,
        set: {
          etag: params.etag ?? null,
          last_modified: params.lastModified ?? null,
          payload_hash: params.payloadHash ?? null,
          payload: params.payload ?? null,
          status: params.status ?? 200,
          failure_count: params.failureCount ?? 0,
          last_checked_at: now,
          updated_at: now,
        },
      });
  } catch (err) {
    // allow-failopen: db write failure should never fail the sweep
    log.warn({ err: (err as Error).message, url: params.url }, "Could not save board cache entry");
  }
}

/**
 * Update timestamp and status on HTTP 304 Not Modified.
 */
export async function touchBoardCacheEntry(url: string, status: number = 304): Promise<void> {
  try {
    const db = getDb();
    const now = new Date();
    await db
      .update(atsBoardCache)
      .set({
        status,
        failure_count: 0,
        last_checked_at: now,
        updated_at: now,
      })
      .where(eq(atsBoardCache.url, url));
  } catch (err) {
    // allow-failopen: db touch failure should never fail the sweep
    log.warn({ err: (err as Error).message, url }, "Could not touch board cache entry");
  }
}

/**
 * Record a failure for a board URL (e.g. 429, 5xx, or network error).
 */
export async function recordBoardCacheFailure(url: string, status?: number): Promise<void> {
  try {
    const db = getDb();
    const now = new Date();
    await db
      .insert(atsBoardCache)
      .values({
        url,
        status: status ?? null,
        failure_count: 1,
        last_checked_at: now,
        updated_at: now,
      })
      .onConflictDoUpdate({
        target: atsBoardCache.url,
        set: {
          status: status ?? null,
          failure_count: sql`${atsBoardCache.failure_count} + 1`,
          last_checked_at: now,
          updated_at: now,
        },
      });
  } catch (err) {
    // allow-failopen: db failure record should never fail the sweep
    log.warn({ err: (err as Error).message, url }, "Could not record board cache failure");
  }
}

/** Test/ops seam: wipe all board cache records. */
export async function clearBoardCache(): Promise<void> {
  try {
    const db = getDb();
    await db.delete(atsBoardCache);
  } catch (err) {
    // allow-failopen: test seam
    log.warn({ err: (err as Error).message }, "Could not clear board cache");
  }
}
