/**
 * Local rerank stage (spec §1.1 F5).
 * ==================================
 * After hybrid fusion, optionally reorder the top passages with a local model
 * (llama3.2:3b via Ollama). Fusion gives a good order from two cheap signals;
 * a rerank pass reads the actual passages against the query and can sharpen the
 * top-k. It is strictly an ACCELERANT — flag-gated OFF by default
 * (RAG_RERANK_ENABLED) and fail-open: if the model is down or unparseable, the
 * fused order stands. Degraded order, never degraded recall, never an error.
 *
 * The model call is injected so the fail-open contract and the index parsing are
 * unit-tested at $0 (the real model needs Ollama on the VPS).
 */
import { ollamaGenerate } from "../lib/ollama.js";
import type { RagHit } from "./rag-search.js";
import type { HybridMode } from "./rag-hybrid.js";

/**
 * Should the fused result be reranked? Rerank uses the same local model family
 * (Ollama) as the embedder, so in `keyword-fallback` — where the embedder is
 * already down — a rerank call would just burn the full model timeout before
 * failing open. Skip it there (and when disabled or there's nothing to reorder)
 * so the degraded path stays fast.
 */
export function shouldRerank(enabled: boolean, mode: HybridMode, hitCount: number): boolean {
  return enabled && mode !== "keyword-fallback" && hitCount > 1;
}

/** Build the ranking prompt. Passages are numbered 1-based (models count from 1),
 *  truncated so a long chunk can't blow the context window. */
export function buildRerankPrompt(query: string, hits: readonly RagHit[]): string {
  const passages = hits
    .map((h, i) => `${i + 1}. ${h.content.slice(0, 500).replace(/\s+/g, " ").trim()}`)
    .join("\n");
  return (
    `Rank the passages below by how well they answer the query. ` +
    `Reply with ONLY the passage numbers, most relevant first, comma-separated (e.g. "3, 1, 2").\n\n` +
    `Query: ${query}\n\nPassages:\n${passages}\n\nRanking:`
  );
}

/**
 * Parse a model ranking into 0-based indices over `n` passages. Extracts integer
 * tokens (tolerating prose/brackets), converts 1-based → 0-based, drops
 * out-of-range and duplicate values, then appends any unmentioned indices in
 * order so no passage is lost. Returns null when nothing usable was found — the
 * caller then keeps the fused order (fail-open).
 */
export function parseRerankOrder(raw: string, n: number): number[] | null {
  const seen = new Set<number>();
  const order: number[] = [];
  for (const tok of raw.match(/\d+/g) ?? []) {
    const idx = Number(tok) - 1; // 1-based → 0-based
    if (idx >= 0 && idx < n && !seen.has(idx)) {
      seen.add(idx);
      order.push(idx);
    }
  }
  if (order.length === 0) return null;
  for (let i = 0; i < n; i++) if (!seen.has(i)) order.push(i); // keep the rest
  return order;
}

/**
 * Rerank `hits` for `query`, returning the top `topK`. Fail-open: 0/1 hits or a
 * missing/garbage model response yields the fused order unchanged. `generate` is
 * injected (defaults to the real Ollama call) for $0 testing.
 */
export async function rerankHits(
  query: string,
  hits: RagHit[],
  topK: number,
  generate: (alias: string, prompt: string) => Promise<string | null> = ollamaGenerate,
): Promise<RagHit[]> {
  if (hits.length <= 1) return hits.slice(0, topK);

  const raw = await generate("classify", buildRerankPrompt(query, hits));
  const order = raw ? parseRerankOrder(raw, hits.length) : null;
  // Accelerant only: no usable ranking → the fused order is already correct.
  if (!order) return hits.slice(0, topK);

  return order.map((i) => hits[i]!).slice(0, topK);
}
