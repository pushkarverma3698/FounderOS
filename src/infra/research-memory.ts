/**
 * FounderOS — Research Memory
 * ============================
 * "Best memory" for the research department. Turns ephemeral scrapes into durable,
 * retrievable knowledge:
 *
 *   1. Cache + dedup  — Redis, keyed by url/query hash (RESEARCH_CACHE_TTL_SECONDS).
 *                       Repeat research is instant and never re-pays Apify credits.
 *   2. Auto-ingest    — scraped markdown is chunked, embedded via local Ollama
 *                       (nomic-embed-text, 768-dim — same path as brain:sync), and
 *                       upserted into the research_cache pgvector table.
 *   3. Citations      — every chunk carries { source_url, title, retrieved_at } in
 *                       metadata so retrieved findings stay verifiable (rule #24).
 *
 * Fail-open everywhere: a cache miss, a Redis outage, or Ollama being down must
 * never break a scrape — ingestion is best-effort and logs the REAL failing
 * component (rule #22), the scrape result still reaches the founder.
 */

import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { cacheGet, cacheSet, KEYS } from "./redis.js";
import { embedTexts, chunkText } from "../lib/embed.js";
import { env } from "../core/config.js";
import { childLogger } from "./logger.js";
import type { ScrapeResult } from "../tools/apify.js";

const log = childLogger({ module: "research-memory" });

/** Postgres vector literal: number[] → "[1,2,3]". */
function toVector(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

// ── Cache (dedup) ───────────────────────────────────────────────────────────

/** Read a cached scrape by its dedup key (url or deep_research query). */
export async function getCachedScrape(key: string): Promise<ScrapeResult[] | null> {
  return cacheGet<ScrapeResult[]>(KEYS.scrape(key));
}

/** Cache a scrape result. Fail-open (no-op if Redis is down). */
export async function setCachedScrape(key: string, results: ScrapeResult[]): Promise<void> {
  await cacheSet(KEYS.scrape(key), results, env.RESEARCH_CACHE_TTL_SECONDS);
}

// ── Ingest (durable RAG memory) ──────────────────────────────────────────────

/**
 * Embed + upsert scraped pages into research_cache. Idempotent per source_url
 * (delete prior chunks, re-insert) — re-scraping a URL refreshes, never duplicates.
 * Best-effort: returns the number of chunks written; 0 on any failure (logged).
 */
export async function ingestResearch(pages: ScrapeResult[]): Promise<number> {
  let total = 0;
  for (const page of pages) {
    if (!page.markdown || page.markdown.trim().length === 0) continue;
    try {
      const chunks = chunkText(page.markdown);
      if (chunks.length === 0) continue;

      const embeddings = await embedTexts(chunks);

      // Idempotent refresh: drop any prior chunks for this URL before inserting.
      if (page.url) {
        await db.execute(
          sql`DELETE FROM research_cache WHERE metadata->>'source_url' = ${page.url}`,
        );
      }

      for (let i = 0; i < chunks.length; i++) {
        const metadata = {
          source_url: page.url,
          title: page.title,
          retrieved_at: page.retrieved_at,
          chunk_index: i,
          chunk_count: chunks.length,
        };
        await db.execute(sql`
          INSERT INTO research_cache (content, metadata, embedding)
          VALUES (${chunks[i]!}, ${JSON.stringify(metadata)}::jsonb, ${toVector(embeddings[i]!)}::vector)
        `);
      }
      total += chunks.length;
    } catch (err) {
      // Name the real failing component (rule #22): embedding (Ollama) vs DB.
      log.error(
        { url: page.url, err },
        "research_cache ingest failed (Ollama embed or Postgres write) — scrape still returned to founder",
      );
    }
  }
  if (total > 0) log.info({ pages: pages.length, chunks: total }, "Ingested scrapes into research_cache");
  return total;
}
