/**
 * pgvector nearest-neighbour search over the isolated RAG tables.
 * Replaces the old ChromaDB HTTP calls. The table name is validated against a
 * hard allowlist before being interpolated into SQL — this both enforces the
 * ADR-013/015 store boundary and prevents SQL injection via table name.
 */
import { sql } from "drizzle-orm";
import { db } from "./client.js";
import { tokenizeQuery, scoreByTerms, rankByTerms } from "./keyword-search.js";

// research_cache holds business-public web findings (not personal data), so it
// sits alongside turicks_brain on the right side of the ADR-013/015 firewall.
export const ALLOWED_RAG_TABLES = new Set(["personal_rag", "turicks_brain", "brain_memories", "research_cache"] as const);
export type RagTable = "personal_rag" | "turicks_brain" | "brain_memories" | "research_cache";

export interface RagHit {
  content: string;
  metadata: Record<string, unknown>;
  score: number; // cosine similarity in [0,1], higher = closer
}

/** Metadata-column equality filter, ANDed onto a search's WHERE clause. */
export interface RagFilter {
  entry_type?: string;
}

/** Throws if `table` is not one of the two allowed RAG tables. */
export function assertAllowedRagTable(table: string): asserts table is RagTable {
  if (!ALLOWED_RAG_TABLES.has(table as RagTable)) {
    throw new Error(`"${table}" is not an allowed RAG table`);
  }
}

/** The schema these stores actually live in — see {@link ragTableRef}. */
const RAG_SCHEMA = "brain";

/**
 * Resolve a RAG table to an explicit `brain.<table>` reference.
 *
 * These queries used to name the table unqualified and let `search_path` resolve
 * it. The dev database holds an empty `agents.turicks_brain` alongside the real
 * `brain.turicks_brain`, and the connection sets
 * `search_path=agents,brain,public` — so `FROM turicks_brain` bound to the empty
 * copy and every vector search returned zero rows. No error, no warning: the
 * caller cannot tell "nothing matched" from "you queried the wrong table".
 *
 * Qualifying the schema removes the ambiguity entirely rather than depending on
 * table ordering in a session variable set somewhere else.
 */
export function ragTableRef(table: RagTable): { schema: string; table: RagTable } {
  assertAllowedRagTable(table);
  return { schema: RAG_SCHEMA, table };
}

/**
 * Return the top-k rows from `table` nearest to `queryEmbedding` by cosine
 * distance. score = 1 - cosine_distance.
 */
export async function searchRagTable(
  table: RagTable,
  queryEmbedding: number[],
  topK: number,
  opts?: { filter?: RagFilter },
): Promise<RagHit[]> {
  assertAllowedRagTable(table);
  const vec = `[${queryEmbedding.join(",")}]`;
  const limit = Math.min(Math.max(topK, 1), 10);
  const entryType = opts?.filter?.entry_type;
  const filterClause = entryType ? sql`AND metadata->>'entry_type' = ${entryType}` : sql``;
  // sql.identifier() safely quotes the (already allowlisted) table name.
  const rows = await db.execute(sql`
    SELECT content, metadata, 1 - (embedding <=> ${vec}::vector) AS score
    FROM ${sql.identifier(RAG_SCHEMA)}.${sql.identifier(table)}
    WHERE embedding IS NOT NULL
    ${filterClause}
    ORDER BY embedding <=> ${vec}::vector
    LIMIT ${limit}
  `);
  // postgres.js driver (drizzle-orm/postgres-js): db.execute returns a RowList,
  // an array-like of row objects directly (NOT a { rows } wrapper like pg).
  return (
    rows as unknown as Array<{
      content: string;
      metadata: Record<string, unknown> | null;
      score: number;
    }>
  ).map((r) => ({ content: r.content, metadata: r.metadata ?? {}, score: Number(r.score) }));
}

/**
 * Keyword search over the SAME rag table as {@link searchRagTable}, using only
 * the `content` column (schema-safe — no tsvector/GIN assumption). The query is
 * tokenised into significant terms; rows matching ANY term are fetched (ILIKE
 * OR), ranked by term overlap IN SQL, and only then truncated. This is the
 * keyword half of hybrid retrieval (spec §1.1 F2) and the fallback when the
 * embedder is down (F1).
 *
 * The ranking has to happen in SQL because the pre-filter is what truncates.
 * This query used to apply `LIMIT` to an unordered OR-match, which let Postgres
 * return ANY rows that matched a single term; `rankByTerms` then ranked that
 * arbitrary sample precisely. Measured on prod 2026-08-19: one golden query
 * matched 255 of 478 chunks, 20 survived at random, and keyword-only recall@5
 * was 0.0% across all 37 golden queries — with no error and no empty result to
 * make it visible. See tests/unit/db/keyword-rag-ranking.test.ts.
 *
 * `score` is the fraction of query terms present (0–1) — a rough relevance that
 * RRF ignores (it fuses by rank), but that keeps the RagHit shape meaningful for
 * keyword-only fallback rendering.
 */
export async function keywordSearchRagTable(
  table: RagTable,
  query: string,
  topK: number,
  opts?: { filter?: RagFilter },
): Promise<RagHit[]> {
  assertAllowedRagTable(table);
  const terms = tokenizeQuery(query);
  if (terms.length === 0) return []; // nothing significant to match on

  const limit = Math.min(Math.max(topK, 1), 10);
  const candidateLimit = Math.min(limit * 4, 40); // over-fetch the BEST rows, then refine in JS

  // OR the per-term ILIKE patterns. Terms are alphanumeric (tokenizeQuery strips
  // punctuation) and still passed as bound params — never interpolated.
  const patterns = terms.map((t) => sql`content ILIKE ${"%" + t + "%"}`);
  let whereOr = patterns[0]!;
  for (let i = 1; i < patterns.length; i++) whereOr = sql`${whereOr} OR ${patterns[i]!}`;

  const entryType = opts?.filter?.entry_type;
  const filterClause = entryType ? sql`AND metadata->>'entry_type' = ${entryType}` : sql``;

  // The SQL mirror of scoreByTerms: one CASE arm per term, summed. Ordering by
  // it makes the LIMIT keep the highest-overlap rows instead of arbitrary ones.
  const arms = terms.map((t) => sql`(CASE WHEN content ILIKE ${"%" + t + "%"} THEN 1 ELSE 0 END)`);
  let matchCount = arms[0]!;
  for (let i = 1; i < arms.length; i++) matchCount = sql`${matchCount} + ${arms[i]!}`;

  const rows = await db.execute(sql`
    SELECT content, metadata, ${matchCount} AS match_count
    FROM ${sql.identifier(RAG_SCHEMA)}.${sql.identifier(table)}
    WHERE (${whereOr})
    ${filterClause}
    ORDER BY match_count DESC, content
    LIMIT ${candidateLimit}
  `);

  const candidates = (
    rows as unknown as Array<{ content: string; metadata: Record<string, unknown> | null }>
  ).map((r) => ({ content: r.content, metadata: r.metadata ?? {} }));

  return rankByTerms(candidates, terms, (c) => c.content, limit).map((c) => ({
    content: c.content,
    metadata: c.metadata,
    score: Math.min(1, scoreByTerms(c.content, terms) / terms.length),
  }));
}

/** Unified Brain Search Interface */
import { hybridRagSearch, HybridResult, RagStageError } from "./rag-hybrid.js";
import { embedText } from "../lib/embed.js";

export interface SearchBrainOptions {
  query: string;
  topK?: number;
  filters?: RagFilter;
  /** Defaults to "brain_memories" — the store brain:sync writes (ADR-038). */
  table?: RagTable;
}

/**
 * Standardized search contract (ADR-038).
 * Wraps hybridRagSearch, automatically managing embeddings and keywords.
 * All clients (FounderOS, MCP) should use this single entry point.
 */
export async function searchBrain(opts: SearchBrainOptions): Promise<HybridResult> {
  const topK = opts.topK ?? 5;
  const table = opts.table ?? "brain_memories";

  return hybridRagSearch(table, opts.query, topK, {
    vectorSearch: async (tbl, q, k) => {
      try {
        const queryEmbedding = await embedText(q);
        return await searchRagTable(tbl, queryEmbedding, k, { filter: opts.filters });
      } catch (err) {
        throw new RagStageError("embed", err instanceof Error ? err.message : String(err));
      }
    },
    keywordSearch: async (tbl, q, k) => {
      return await keywordSearchRagTable(tbl, q, k, { filter: opts.filters });
    },
  });
}
