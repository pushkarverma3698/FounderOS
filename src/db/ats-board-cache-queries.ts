import { eq } from "drizzle-orm";
import { db } from "./client.js";
import { atsBoardCache } from "./schema.js";

export async function getAtsCache(url: string) {
  const result = await db.select().from(atsBoardCache).where(eq(atsBoardCache.url, url)).limit(1);
  return result[0] ?? null;
}

export async function setAtsCache(url: string, etag: string | null | undefined, payload: unknown) {
  if (typeof etag !== "string" || etag.length === 0) {
    await db.delete(atsBoardCache).where(eq(atsBoardCache.url, url));
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
