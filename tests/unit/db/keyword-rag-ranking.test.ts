/**
 * Regression: the keyword half of hybrid retrieval must RANK BEFORE IT LIMITS.
 *
 * Measured on prod 2026-08-19 (AG-010): keyword-only recall@5 was **0.0% on
 * 37/37 golden queries**. Root cause is not the ranking — `rankByTerms` is
 * correct and unit-tested — it is that the SQL pre-filter handed it the wrong
 * rows. The query ORed the per-term ILIKE patterns and applied `LIMIT 40` with
 * **no `ORDER BY`**, so Postgres was free to return any 40 of the matching rows.
 * One golden query matched 255 of 478 chunks; an arbitrary 40 survived, and
 * `rankByTerms` then ranked a random sample precisely. The code comment claimed
 * "over-fetch, then rank precisely" and did neither.
 *
 * These tests inspect the SQL the function actually sends, because the defect
 * lives in the query, not in any JS the suite can call directly.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const execute = vi.fn();

vi.mock("../../../src/db/client.js", () => ({ db: { execute } }));

const { keywordSearchRagTable } = await import("../../../src/db/rag-search.js");

/** Flatten a drizzle `sql` template (including nested fragments) to its literal text. */
function sqlTextOf(chunkHolder: { queryChunks: unknown[] }): string {
  let out = "";
  for (const chunk of chunkHolder.queryChunks) {
    const c = chunk as { value?: unknown; queryChunks?: unknown[] };
    if (Array.isArray(c.queryChunks)) out += sqlTextOf(c as { queryChunks: unknown[] });
    else if (Array.isArray(c.value)) out += (c.value as string[]).join("");
  }
  return out;
}

async function capturedSql(query: string, topK = 5): Promise<string> {
  execute.mockResolvedValueOnce([]);
  await keywordSearchRagTable("turicks_brain", query, topK);
  return sqlTextOf(execute.mock.calls[0]![0] as { queryChunks: unknown[] });
}

describe("keywordSearchRagTable — ranks in SQL before truncating", () => {
  beforeEach(() => execute.mockReset());

  it("orders the candidate set before applying LIMIT", async () => {
    const text = await capturedSql("langgraph supervisor dispatch cursor");

    const orderBy = text.toUpperCase().indexOf("ORDER BY");
    const limit = text.toUpperCase().lastIndexOf("LIMIT");

    expect(orderBy).toBeGreaterThan(-1);
    expect(limit).toBeGreaterThan(orderBy);
  });

  it("ranks by how many query terms a row matches, not by an arbitrary column", async () => {
    const text = await capturedSql("langgraph supervisor dispatch cursor");

    // One CASE arm per significant term, summed — the SQL mirror of scoreByTerms.
    const armCount = (text.match(/WHEN content ILIKE/gi) ?? []).length;
    expect(armCount).toBe(4); // langgraph, supervisor, dispatch, cursor

    expect(text.toUpperCase()).toContain("ORDER BY MATCH_COUNT DESC");
  });

  it("breaks ties deterministically so two identical runs cannot disagree", async () => {
    // Rule #16: retrieval is deterministic. Equal-overlap rows must not be
    // returned in whatever order the heap happens to produce.
    const first = await capturedSql("langgraph supervisor dispatch cursor");
    execute.mockReset();
    const second = await capturedSql("langgraph supervisor dispatch cursor");

    expect(first).toBe(second);
    expect(first.toUpperCase()).toContain("MATCH_COUNT DESC, CONTENT");
  });

  it("still short-circuits an all-stopword query without touching the database", async () => {
    execute.mockResolvedValueOnce([]);
    const hits = await keywordSearchRagTable("turicks_brain", "what did we decide about the", 5);

    expect(hits).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });
});
