/**
 * Reciprocal Rank Fusion (RRF) — pure, deterministic list merging (spec §1.1 F2).
 * ==============================================================================
 * Combines independent ranked lists (e.g. pgvector similarity + keyword overlap)
 * into a single order WITHOUT needing their scores to be comparable — vector
 * cosine and keyword term-overlap live on different scales, so you cannot just
 * add them. RRF sidesteps that: each list contributes `1/(k + rank)` per item,
 * and per-document contributions sum. A document ranked well in both lists beats
 * one ranked well in only one.
 *
 * It is pure arithmetic — no LLM, no I/O — which is exactly the v3 doctrine
 * (routing/ranking is code, not a prompt) and makes it unit-testable at $0.
 */

/** The standard RRF constant (Cormack et al. 2009). Larger k → flatter weighting
 *  (rank position matters less); 60 is the widely-used default. */
export const RRF_K = 60;

export interface FusedItem<T> {
  /** The representative object (first list it was seen in). */
  item: T;
  /** Summed reciprocal-rank score across all input lists. Higher = better. */
  score: number;
  /** How many input lists contained this document (1 = single-source). */
  sources: number;
}

/**
 * Fuse ranked `lists` into one order by Reciprocal Rank Fusion.
 *
 * @param lists  ranked lists, each already ordered best-first.
 * @param keyOf  identity of a document, so the same doc across lists accumulates
 *               (and is de-duplicated). Use a stable field — content or an id.
 * @param k      RRF constant (default {@link RRF_K}).
 * @returns fused items sorted by score desc; ties break to first-seen order
 *          (deterministic — the same inputs always produce the same output).
 */
export function reciprocalRankFusion<T>(
  lists: readonly (readonly T[])[],
  keyOf: (item: T) => string,
  k: number = RRF_K,
): Array<FusedItem<T>> {
  const acc = new Map<string, FusedItem<T> & { order: number }>();
  let order = 0;

  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const item = list[rank]!;
      const key = keyOf(item);
      const contribution = 1 / (k + rank + 1); // rank is 1-based in the formula
      const existing = acc.get(key);
      if (existing) {
        existing.score += contribution;
        existing.sources += 1;
      } else {
        acc.set(key, { item, score: contribution, sources: 1, order: order++ });
      }
    }
  }

  return [...acc.values()]
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map(({ item, score, sources }) => ({ item, score, sources }));
}
