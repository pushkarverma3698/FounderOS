/**
 * A brain_memories row marked SUPERSEDED or ARCHIVED is not returned by either search leg.
 * ========================================================================================
 * The `status` column has existed since migration 0037 but no query read it, so a plan the founder had replaced still
 * ranked like a current one. STALE stays searchable on purpose: stale means "check before relying on it", not "gone".
 *
 * The other RAG tables have no `status` column, so the clause must not be added to them (Postgres would reject it).
 *
 * db.execute is mocked, same as rag-search-filters.test.ts: this pins the SQL text, not a live Postgres.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const execute = vi.fn().mockResolvedValue([]);
vi.mock("../../../src/db/client.js", () => ({ db: { execute } }));

const { searchRagTable, keywordSearchRagTable } = await import("../../../src/db/rag-search.js");

const dialect = new PgDialect();
function lastQuery() {
  return dialect.sqlToQuery(execute.mock.calls.at(-1)?.[0]);
}

const embedding = [0.1, 0.2, 0.3];
const EXCLUDES_REPLACED = /AND status NOT IN \('SUPERSEDED', 'ARCHIVED'\)/;

beforeEach(() => {
  execute.mockReset();
  execute.mockResolvedValue([]);
});

describe("vector leg", () => {
  it("excludes SUPERSEDED and ARCHIVED rows from brain_memories", async () => {
    await searchRagTable("brain_memories", embedding, 5);
    expect(lastQuery().sql).toMatch(EXCLUDES_REPLACED);
  });

  it("does not exclude STALE", async () => {
    await searchRagTable("brain_memories", embedding, 5);
    expect(lastQuery().sql).not.toMatch(/STALE/);
  });

  it("composes with the other filters as AND, with no param glued onto the next clause", async () => {
    await searchRagTable("brain_memories", embedding, 5, { filter: { memory_type: "decision", project: "oplify" } });
    const { sql, params } = lastQuery();
    expect(sql).toMatch(EXCLUDES_REPLACED);
    expect(sql).toMatch(/AND memory_type = /);
    expect(sql).toMatch(/AND project = /);
    expect(params).toEqual(expect.arrayContaining(["decision", "oplify"]));
    expect(sql).not.toMatch(/\$\d+[A-Za-z]/);
  });

  it.each(["personal_rag", "research_cache"] as const)("leaves %s alone: it has no status column", async (table) => {
    await searchRagTable(table, embedding, 5);
    expect(lastQuery().sql).not.toMatch(/status/);
  });
});

describe("keyword leg", () => {
  it("excludes SUPERSEDED and ARCHIVED rows from brain_memories", async () => {
    await keywordSearchRagTable("brain_memories", "oplify billing", 5);
    expect(lastQuery().sql).toMatch(EXCLUDES_REPLACED);
  });

  it("applies the exclusion to the whole OR of terms, not just the last term", async () => {
    await keywordSearchRagTable("brain_memories", "oplify billing", 5);
    const { sql } = lastQuery();
    // The ILIKE terms sit inside their own parentheses; the status clause must come after the closing one.
    expect(sql).toMatch(/WHERE \(.*ILIKE.*OR.*ILIKE.*\)\s+AND status NOT IN/s);
  });

  it("composes with the other filters as AND, with no param glued onto the next clause", async () => {
    await keywordSearchRagTable("brain_memories", "oplify billing", 5, {
      filter: { memory_type: "decision", project: "oplify" },
    });
    const { sql } = lastQuery();
    expect(sql).toMatch(EXCLUDES_REPLACED);
    expect(sql).not.toMatch(/\$\d+[A-Za-z]/);
  });

  it.each(["personal_rag", "research_cache"] as const)("leaves %s alone: it has no status column", async (table) => {
    await keywordSearchRagTable(table, "oplify billing", 5);
    expect(lastQuery().sql).not.toMatch(/status/);
  });
});
