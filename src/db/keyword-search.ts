/**
 * FounderOS — Keyword Search Helpers (pure, deterministic)
 * ========================================================
 * The memory/knowledge tables are searched with keyword ILIKE (no embeddings).
 * The naive approach — a single `ILIKE '%<entire query>%'` — only matches when
 * the founder's words appear as a contiguous substring of the row. A natural
 * question like "what did we decide about the engine swap to Claude Code?"
 * then matches NOTHING, because the filler word "to" breaks the substring.
 *
 * These helpers split a query into significant terms and rank candidate rows by
 * how many distinct terms they contain (term-overlap relevance). Pure functions,
 * unit-tested — the SQL layer ORs the per-term patterns, then ranks in JS.
 *
 * Rationale (rule #16): retrieval must be deterministic and reproducible, not a
 * prompt instruction the model may or may not satisfy with a lucky re-query.
 */

const MIN_TERM_LENGTH = 3;

/** Words too common to be useful as search terms (they match almost everything). */
const SEARCH_STOP_WORDS = new Set([
  "the", "and", "for", "are", "was", "were", "did", "what", "when", "where",
  "which", "who", "why", "how", "you", "your", "our", "about", "with", "that",
  "this", "these", "those", "have", "has", "had", "can", "could", "should",
  "would", "from", "into", "out", "off", "all", "any", "but", "not", "get",
  "got", "let", "tell", "show", "give", "want", "need", "know", "decide",
  "decided", "discuss", "discussed", "recall", "remember", "regarding",
]);

/**
 * Break a free-text query into distinct, lowercased significant terms.
 * Drops punctuation, stop words, and terms shorter than MIN_TERM_LENGTH.
 * De-duplicated, order-preserving. Returns [] for an empty/all-stopword query.
 */
export function tokenizeQuery(query: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of query.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < MIN_TERM_LENGTH) continue;
    if (SEARCH_STOP_WORDS.has(raw)) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    terms.push(raw);
  }
  return terms;
}

/**
 * Count how many of `terms` appear (case-insensitively, as substrings) in the
 * combined haystack text. Used to rank candidate rows by term overlap.
 */
export function scoreByTerms(haystack: string, terms: string[]): number {
  if (terms.length === 0) return 0;
  const lower = haystack.toLowerCase();
  let score = 0;
  for (const t of terms) {
    if (lower.includes(t)) score += 1;
  }
  return score;
}

/**
 * Rank candidate rows by term-overlap score (desc), keeping only rows that
 * match at least one term, then take the top `limit`. Stable for equal scores
 * (preserves the input order, which the SQL layer already sorts by recency).
 *
 * @param rows      candidate rows (already OR-matched in SQL)
 * @param terms     significant query terms from tokenizeQuery
 * @param toText    projects a row to its searchable text (title + content + tags)
 * @param limit     max rows to return
 */
export function rankByTerms<T>(
  rows: readonly T[],
  terms: string[],
  toText: (row: T) => string,
  limit: number,
): T[] {
  if (terms.length === 0) return rows.slice(0, limit);
  return rows
    .map((row, index) => ({ row, index, score: scoreByTerms(toText(row), terms) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => (b.score - a.score) || (a.index - b.index))
    .slice(0, limit)
    .map((c) => c.row);
}
