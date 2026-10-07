/**
 * Group-chat privacy for Mac-captured rows (AG-027, audit F3).
 * db.execute is mocked and the compiled SQL is inspected, as in rag-search-filters.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { isFounderThread, visibilityFilter } from "../../../src/db/brain-visibility.js";

const execute = vi.fn().mockResolvedValue([]);
vi.mock("../../../src/db/client.js", () => ({ db: { execute } }));
const { searchRagTable, keywordSearchRagTable } = await import("../../../src/db/rag-search.js");

const dialect = new PgDialect();
const lastSql = () => dialect.sqlToQuery(execute.mock.calls.at(-1)?.[0]).sql;
const VISIBILITY_SQL = /AND COALESCE\(metadata->>'visibility', 'all'\) <> 'founder'/;

beforeEach(() => {
  execute.mockReset();
  execute.mockResolvedValue([]);
});

describe("isFounderThread / visibilityFilter", () => {
  const DM = "turicks:12345";
  const FAMILY_GROUP = "turicks:-5319642142";

  it("is true only for the founder's own chat thread", () => {
    expect(isFounderThread(DM, "turicks", "12345")).toBe(true);
    expect(isFounderThread(FAMILY_GROUP, "turicks", "12345")).toBe(false);
  });

  it("is false for a missing thread and for another tenant", () => {
    expect(isFounderThread("", "turicks", "12345")).toBe(false);
    expect(isFounderThread("other:12345", "turicks", "12345")).toBe(false);
  });

  it("excludes founder-only rows for the family group and for no thread, not for the DM", () => {
    expect(visibilityFilter(FAMILY_GROUP, "turicks", "12345")).toEqual({ excludeFounderOnly: true });
    expect(visibilityFilter("", "turicks", "12345")).toEqual({ excludeFounderOnly: true });
    expect(visibilityFilter(DM, "turicks", "12345")).toEqual({});
  });
});

describe("rag-search visibility clause", () => {
  it("vector leg: the family-group filter removes visibility=founder rows in SQL", async () => {
    await searchRagTable("brain_memories", [0.1, 0.2], 5, { filter: visibilityFilter("turicks:-5319642142", "turicks", "12345") });
    expect(lastSql()).toMatch(VISIBILITY_SQL);
  });

  it("keyword leg: the same clause is present", async () => {
    await keywordSearchRagTable("brain_memories", "capture session", 5, { filter: { excludeFounderOnly: true } });
    expect(lastSql()).toMatch(VISIBILITY_SQL);
  });

  it("founder DM: no visibility clause, so founder rows are returned", async () => {
    await searchRagTable("brain_memories", [0.1, 0.2], 5, { filter: visibilityFilter("turicks:12345", "turicks", "12345") });
    expect(lastSql()).not.toMatch(/visibility/);
  });

  it("keeps rows with no visibility key (COALESCE to all) and composes with other filters", async () => {
    await searchRagTable("brain_memories", [0.1, 0.2], 5, { filter: { excludeFounderOnly: true, project: "oplify" } });
    const sql = lastSql();
    expect(sql).toMatch(/AND project = /);
    expect(sql).toMatch(VISIBILITY_SQL);
    expect(sql).not.toMatch(/\$\d+[A-Za-z]/);
  });

  it("rejects the filter on a table that has no metadata visibility semantics", async () => {
    await expect(searchRagTable("personal_rag", [0.1], 5, { filter: { excludeFounderOnly: true } })).rejects.toThrow(/brain_memories/);
  });
});
