/**
 * pgvector nearest-neighbour search over the isolated RAG tables.
 * Replaces the old ChromaDB HTTP calls. The table name is validated against a
 * hard allowlist before being interpolated into SQL — this both enforces the
 * ADR-013/015 store boundary and prevents SQL injection via table name.
 */
import { sql } from "drizzle-orm";
import { db } from "./client.js";

export const ALLOWED_RAG_TABLES = new Set(["personal_rag", "turicks_brain"] as const);
export type RagTable = "personal_rag" | "turicks_brain";

export interface RagHit {
  content: string;
  metadata: Record<string, unknown>;
  score: number; // cosine similarity in [0,1], higher = closer
}

/** Throws if `table` is not one of the two allowed RAG tables. */
export function assertAllowedRagTable(table: string): asserts table is RagTable {
  if (!ALLOWED_RAG_TABLES.has(table as RagTable)) {
    throw new Error(`"${table}" is not an allowed RAG table`);
  }
}

/**
 * Return the top-k rows from `table` nearest to `queryEmbedding` by cosine
 * distance. score = 1 - cosine_distance.
 */
export async function searchRagTable(
  table: RagTable,
  queryEmbedding: number[],
  topK: number,
): Promise<RagHit[]> {
  assertAllowedRagTable(table);
  const vec = `[${queryEmbedding.join(",")}]`;
  const limit = Math.min(Math.max(topK, 1), 10);
  // sql.identifier() safely quotes the (already allowlisted) table name.
  const rows = await db.execute(sql`
    SELECT content, metadata, 1 - (embedding <=> ${vec}::vector) AS score
    FROM ${sql.identifier(table)}
    WHERE embedding IS NOT NULL
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
