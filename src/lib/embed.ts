/**
 * Local embedding via Ollama (nomic-embed-text). Used for RAG query embedding.
 * RAG text never leaves the box — privacy requirement (no API egress).
 */
import { env } from "../core/config.js";
import { childLogger } from "../infra/logger.js";
import { cacheGet, cacheSet, KEYS } from "../infra/redis.js";

const log = childLogger({ module: "lib:embed" });

/** TTL for a cached query embedding (spec §1.1 F3). 30 days — embeddings are
 *  deterministic, so a long TTL is safe; the model rarely changes and a model
 *  change gets a different cache key anyway. */
export const EMBED_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;

interface OllamaEmbedResponse {
  embedding?: number[];
}

/** Embed a single string into a vector. Throws on failure (fail-loud). */
export async function embedText(text: string): Promise<number[]> {
  let resp: Response;
  try {
    resp = await fetch(`${env.OLLAMA_URL}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: env.EMBED_MODEL, prompt: text }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    log.error({ err }, "Ollama embeddings unreachable");
    throw new Error(
      `Ollama embeddings unreachable at ${env.OLLAMA_URL}. Is the ollama container up and is '${env.EMBED_MODEL}' pulled?`,
    );
  }
  if (!resp.ok) {
    throw new Error(`Ollama embeddings returned HTTP ${resp.status}`);
  }
  const data = (await resp.json()) as OllamaEmbedResponse;
  if (!data.embedding || data.embedding.length === 0) {
    throw new Error("Ollama embeddings response missing 'embedding' field");
  }
  return data.embedding;
}

/** Cache key for a query embedding — model + text, so a model swap or a
 *  different query never collides. See KEYS.embed (single source of key format). */
export function embedCacheKey(text: string, model: string = env.EMBED_MODEL): string {
  return KEYS.embed(model, text);
}

/** Injectable cache/embed seams so the cache is unit-tested at $0. Defaults to
 *  the real Redis helpers (fail-open) and the real embedder. */
export interface EmbedCacheDeps {
  get: <T>(key: string) => Promise<T | null>;
  set: (key: string, value: unknown, ttlSeconds: number) => Promise<void>;
  embed: (text: string) => Promise<number[]>;
}

const DEFAULT_EMBED_CACHE_DEPS: EmbedCacheDeps = {
  get: cacheGet,
  set: cacheSet,
  embed: embedText,
};

/**
 * Embed a query, reading through a Redis cache (spec §1.1 F3). On a hit the
 * embedder is never called; on a miss the fresh vector is written back with a
 * 30-day TTL. Fail-open: cacheGet/cacheSet never throw (no Redis → miss/no-op),
 * so this behaves exactly like {@link embedText} when the cache is unavailable —
 * a real embed failure still propagates (the cache must never mask a dead Ollama).
 */
export async function embedTextCached(
  text: string,
  deps: EmbedCacheDeps = DEFAULT_EMBED_CACHE_DEPS,
): Promise<number[]> {
  const key = embedCacheKey(text);
  const cached = await deps.get<number[]>(key);
  if (Array.isArray(cached) && cached.length > 0) return cached;

  const vec = await deps.embed(text);
  await deps.set(key, vec, EMBED_CACHE_TTL_SECONDS);
  return vec;
}

/**
 * Split text into overlapping character chunks for embedding.
 * nomic-embed-text silently truncates long input (~2k token window), so a
 * single embed of a large doc loses its tail. Chunking keeps every section
 * retrievable. Splits on paragraph boundaries where possible to avoid cutting
 * mid-sentence.
 */
export function chunkText(text: string, maxChars = 1800, overlap = 200): string[] {
  const clean = text.trim();
  if (clean.length <= maxChars) return clean.length > 0 ? [clean] : [];

  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + maxChars, clean.length);
    // Prefer to break on a paragraph/sentence boundary inside the last 25%.
    if (end < clean.length) {
      const window = clean.slice(start, end);
      const breakAt = Math.max(
        window.lastIndexOf("\n\n"),
        window.lastIndexOf(". "),
        window.lastIndexOf("\n"),
      );
      if (breakAt > maxChars * 0.75) end = start + breakAt + 1;
    }
    chunks.push(clean.slice(start, end).trim());
    if (end >= clean.length) break;
    start = end - overlap; // overlap so context isn't lost at the seam
  }
  return chunks.filter((c) => c.length > 0);
}

/** Embed many strings with bounded concurrency (avoids hammering Ollama). */
export async function embedTexts(texts: string[], concurrency = 4): Promise<number[][]> {
  const out: number[][] = new Array<number[]>(texts.length);
  for (let i = 0; i < texts.length; i += concurrency) {
    const slice = texts.slice(i, i + concurrency);
    const embedded = await Promise.all(slice.map((t) => embedText(t)));
    for (let j = 0; j < embedded.length; j++) out[i + j] = embedded[j]!;
  }
  return out;
}
