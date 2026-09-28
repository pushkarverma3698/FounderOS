/**
 * Unit tests for the brain_memories-only `memory_type` / `project` filters
 * added to searchRagTable / keywordSearchRagTable.
 *
 * Regression this pins: search_memory's `memoryType` argument used to filter on
 * `metadata->>'entry_type'`, but brain_memories rows carry type in the real
 * `memory_type` column (metadata.entry_type is rarely set there) — so the
 * filter silently matched almost nothing. There was also no way to scope a
 * query to one `project` at all, so a query from an Oplify session could
 * surface unrelated personal rows and vice versa.
 *
 * db.execute is mocked — no live Postgres needed ($0, matches the
 * research-memory.test.ts precedent for mocking src/db/client.js).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const execute = vi.fn().mockResolvedValue([]);
vi.mock("../../../src/db/client.js", () => ({ db: { execute } }));

const { searchRagTable, keywordSearchRagTable } = await import("../../../src/db/rag-search.js");

const dialect = new PgDialect();
/** Compile the SQL object passed to the most recent db.execute call into {sql, params}. */
function lastQuery() {
  const call = execute.mock.calls.at(-1)?.[0];
  return dialect.sqlToQuery(call);
}

const embedding = [0.1, 0.2, 0.3];

beforeEach(() => {
  execute.mockReset();
  execute.mockResolvedValue([]);
});

describe("searchRagTable — memory_type / project filters", () => {
  it("filters brain_memories by memory_type using the real column", async () => {
    await searchRagTable("brain_memories", embedding, 5, { filter: { memory_type: "decision" } });
    const { sql, params } = lastQuery();
    expect(sql).toMatch(/AND memory_type = /);
    expect(params).toContain("decision");
  });

  it("filters brain_memories by project using the real column", async () => {
    await searchRagTable("brain_memories", embedding, 5, { filter: { project: "oplify" } });
    const { sql, params } = lastQuery();
    expect(sql).toMatch(/AND project = /);
    expect(params).toContain("oplify");
  });

  it("composes memory_type + project as AND, not OR, with valid SQL punctuation", async () => {
    await searchRagTable("brain_memories", embedding, 5, {
      filter: { memory_type: "decision", project: "oplify" },
    });
    const { sql, params } = lastQuery();
    expect(sql).toMatch(/AND memory_type = /);
    expect(sql).toMatch(/AND project = /);
    expect(params).toEqual(expect.arrayContaining(["decision", "oplify"]));
    // Regression: adjacent filter fragments concatenate with no separator of
    // their own — a bound param glued straight onto the next "AND" (`$2AND`)
    // compiles fine here but is invalid Postgres syntax at query time.
    expect(sql).not.toMatch(/\$\d+[A-Za-z]/);
  });

  it("always selects memory_type/project for brain_memories, filter or not", async () => {
    await searchRagTable("brain_memories", embedding, 5);
    const { sql } = lastQuery();
    expect(sql).toMatch(/SELECT content, metadata, memory_type, project,/);
  });

  it("does not select memory_type/project for tables that lack those columns", async () => {
    await searchRagTable("personal_rag", embedding, 5);
    const { sql } = lastQuery();
    expect(sql).not.toMatch(/memory_type/);
    expect(sql).not.toMatch(/project/);
  });

  it("refuses a memory_type/project filter on a table that doesn't have those columns", async () => {
    await expect(
      searchRagTable("personal_rag", embedding, 5, { filter: { project: "oplify" } }),
    ).rejects.toThrow(/memory_type\/project filters require table "brain_memories"/);
  });

  it("surfaces memory_type/project on the returned hit for brain_memories", async () => {
    execute.mockResolvedValueOnce([
      { content: "a decision about billing", metadata: {}, memory_type: "decision", project: "oplify", score: "0.9" },
    ]);
    const hits = await searchRagTable("brain_memories", embedding, 5);
    expect(hits[0]).toMatchObject({ memory_type: "decision", project: "oplify" });
  });
});

describe("keywordSearchRagTable — memory_type / project filters", () => {
  it("filters brain_memories by memory_type using the real column", async () => {
    await keywordSearchRagTable("brain_memories", "oplify billing", 5, { filter: { memory_type: "decision" } });
    const { sql, params } = lastQuery();
    expect(sql).toMatch(/AND memory_type = /);
    expect(params).toContain("decision");
  });

  it("filters brain_memories by project using the real column", async () => {
    await keywordSearchRagTable("brain_memories", "oplify billing", 5, { filter: { project: "oplify" } });
    const { sql, params } = lastQuery();
    expect(sql).toMatch(/AND project = /);
    expect(params).toContain("oplify");
  });

  it("refuses a memory_type/project filter on a table that doesn't have those columns", async () => {
    await expect(
      keywordSearchRagTable("research_cache", "query", 5, { filter: { memory_type: "bug" } }),
    ).rejects.toThrow(/memory_type\/project filters require table "brain_memories"/);
  });

  it("composes memory_type + project as AND with valid SQL punctuation", async () => {
    await keywordSearchRagTable("brain_memories", "oplify billing", 5, {
      filter: { memory_type: "decision", project: "oplify" },
    });
    const { sql, params } = lastQuery();
    expect(sql).toMatch(/AND memory_type = /);
    expect(sql).toMatch(/AND project = /);
    expect(params).toEqual(expect.arrayContaining(["decision", "oplify"]));
    expect(sql).not.toMatch(/\$\d+[A-Za-z]/);
  });

  it("surfaces memory_type/project on the returned hit for brain_memories", async () => {
    execute.mockResolvedValueOnce([
      {
        content: "oplify billing decision on razorpay",
        metadata: {},
        memory_type: "decision",
        project: "oplify",
        match_count: 2,
      },
    ]);
    const hits = await keywordSearchRagTable("brain_memories", "oplify billing", 5);
    expect(hits[0]).toMatchObject({ memory_type: "decision", project: "oplify" });
  });
});
