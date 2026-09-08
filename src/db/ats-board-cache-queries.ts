import { eq } from "drizzle-orm";
import { db } from "./client.js";
import { atsBoardCache } from "./schema.js";

export async function getAtsCache(url: string) {
  const result = await db.select().from(atsBoardCache).where(eq(atsBoardCache.url, url)).limit(1);
  return result[0] ?? null;
}

/**
 * Remember a 200, or forget a URL that has stopped sending a validator.
 *
 * THE DELETE IS CONDITIONAL, since 2026-09-08. Invalidating on a missing ETag is
 * correct — a board that stopped sending one must not keep serving a stale
 * validator — but it was issued unconditionally, so the ~1,450 boards of 3,223
 * that have NEVER sent an ETag (Workday and BambooHR send none at all) each took
 * a DELETE on every one of the 48 daily sweeps: roughly 70,000 statements a day
 * that could never match a row, and the dead tuples behind autovacuum running on
 * this table every half hour. Checking for the row first turns almost all of them
 * into a cheap indexed lookup.
 */
export async function setAtsCache(url: string, etag: string | null | undefined, payload: unknown) {
  if (typeof etag !== "string" || etag.length === 0) {
    // Only delete something that is actually there.
    if (await getAtsCache(url)) {
      await db.delete(atsBoardCache).where(eq(atsBoardCache.url, url));
    }
    return;
  }
  await db
    .insert(atsBoardCache)
    .values({
      url,
      etag,
      payload,
      updated_at: new Date(),
    })
    .onConflictDoUpdate({
      target: atsBoardCache.url,
      set: {
        etag,
        payload,
        updated_at: new Date(),
      },
    });
}
