/**
 * Brain write ⇄ read parity contract.
 * ===================================
 * 2026-09-05 incident: ADR-038 moved `pnpm brain:sync` off `brain.turicks_brain`
 * and onto `brain.brain_memories`, but every retrieval path — search_knowledge,
 * search_turicks_brain, the RAG health sweep — was left reading the old table.
 * `pnpm gate` stayed green through all 3,726 tests, because the unit suite mocks
 * the database and no test asserts that the writer and the readers agree on a
 * name.
 *
 * The shape of that failure is the one this repo has already paid for twice:
 * on 2026-08-07 an empty `agents.turicks_brain` shadowed the real one and vector
 * search returned zero rows for weeks. Nothing errors. Retrieval keeps answering
 * — from a table that can never be refreshed — so "stale" and "correct" look
 * identical from Telegram.
 *
 * The invariant this pins: there is exactly ONE brain store name, and the
 * ingestion script, the two search tools and the health sweep all use it. This
 * is a source-text contract on purpose — a mocked DB cannot see a table name.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = (rel: string): string => fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
const read = (rel: string): string => readFileSync(root(rel), "utf-8");

/**
 * Every `brain.<table>` named in a SQL position. Anchored on the SQL keyword
 * rather than on `brain.` alone, because the writer's own filename
 * (`sync-turicks-brain.ts`) contains that substring.
 */
function sqlTables(source: string): string[] {
  return [...source.matchAll(/\b(?:FROM|INTO|UPDATE|JOIN)\s+brain\.([a-z_]+)/gi)].map((m) => m[1]!);
}

/** Every table passed as the first argument to runRagSearch(...). */
function ragSearchTables(source: string): string[] {
  return [...source.matchAll(/runRagSearch\(\s*"([a-z_]+)"/g)].map((m) => m[1]!);
}

/**
 * THREE scripts write the brain, not one. ADR-038 moved only the first and left
 * the other two behind — measured on the dev DB 2026-09-05, those two owned
 * 2,642 of 4,018 rows, 66% of the corpus. Repointing readers without them would
 * have made the entire conversation memory invisible instead of fixing anything.
 */
const WRITERS = [
  "scripts/sync-turicks-brain.ts", // docs/ → source_path + entry_type
  "scripts/ingest-claude-sessions.ts", // Claude transcripts → source + doc_type
  "scripts/sync-conversation-session.ts", // Antigravity transcripts, no embedding
] as const;

describe("brain store parity — the writers and the readers name the same table", () => {
  it.each(WRITERS)("%s writes exactly one brain table, and it is brain_memories", (writer) => {
    const inserts = [...read(writer).matchAll(/INSERT INTO brain\.([a-z_]+)/g)].map((m) => m[1]!);
    expect(inserts.length).toBeGreaterThan(0);
    expect([...new Set(inserts)]).toEqual(["brain_memories"]);
  });

  it.each(WRITERS)("%s reads and deletes from the table it writes", (writer) => {
    // A DELETE or watermark COUNT against a different table than the INSERT is
    // how a sync silently stops being idempotent: it clears rows nobody serves
    // and duplicates into the store retrieval actually reads.
    for (const table of sqlTables(read(writer))) {
      expect(table).toBe("brain_memories");
    }
  });

  it("search_knowledge queries the table brain:sync writes, on both call sites", () => {
    // Two: the entry_type-filtered search and its unfiltered retry. The retry
    // is the path a model falls back to before it would otherwise hallucinate,
    // so it must not be the one left pointing at a frozen table.
    const tables = ragSearchTables(read("src/tools/knowledge.ts"));
    expect(tables).toEqual(["brain_memories", "brain_memories"]);
  });

  it("no search tool anywhere still reads the retired turicks_brain table", () => {
    // rag.ts legitimately searches three stores; what must not survive is any
    // reader still naming the table brain:sync stopped writing.
    for (const file of ["src/tools/rag.ts", "src/tools/knowledge.ts", "src/db/rag-search.ts"]) {
      expect(ragSearchTables(read(file))).not.toContain("turicks_brain");
    }
    expect(ragSearchTables(read("src/tools/rag.ts"))).toContain("brain_memories");
  });

  it("the RAG health sweep counts the table retrieval reads", () => {
    // Counting a different table reports a healthy store built from rows no
    // search can return — worse than reporting empty, because it silences the
    // one alarm that exists.
    const tables = sqlTables(read("src/infra/rag-optimization-sweep.ts"));
    expect(tables).toContain("brain_memories");
    expect(tables).not.toContain("turicks_brain");
  });

  it("searchBrain defaults to the table brain:sync writes", () => {
    expect(read("src/db/rag-search.ts")).toContain(`opts.table ?? "brain_memories"`);
  });

  it("a migration carries the old corpus across, so flipping the read path loses nothing", () => {
    const backfill = read("drizzle/0038_brain_backfill.sql");
    expect(backfill).toMatch(/INSERT INTO "brain"\."brain_memories"/);
    expect(backfill).toMatch(/FROM "brain"\."turicks_brain"/);
    // Without a vector index every semantic search over the new table is a
    // sequential scan; turicks_brain has had an HNSW index since 0005_pgvector.
    expect(backfill).toMatch(/CREATE INDEX IF NOT EXISTS "brain_memories_embedding_idx"/);
    expect(backfill).toMatch(/hnsw \(embedding vector_cosine_ops\)/);
  });

  it("the backfill reads BOTH metadata shapes, so transcripts are not dropped", () => {
    // 2,642 of 4,018 rows on the dev DB carry no source_path — they are Claude
    // and Antigravity session transcripts, keyed on `source`/`doc_type` by the
    // other two writers. Coalescing only the doc-sync keys would land them with
    // a NULL source and no usable type, which is how 66% of the brain goes
    // missing without a single error.
    const backfill = read("drizzle/0038_brain_backfill.sql");
    expect(backfill).toContain("tb.metadata->>'source_path'");
    expect(backfill).toContain("tb.metadata->>'source'");
    expect(backfill).toContain("tb.metadata->>'entry_type'");
    expect(backfill).toContain("tb.metadata->>'doc_type'");
  });
});
