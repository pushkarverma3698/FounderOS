import { describe, it, expect } from "vitest";
import {
  assertAllowedRagTable,
  ALLOWED_RAG_TABLES,
  ragTableRef,
} from "../../../src/db/rag-search.js";

describe("ragTableRef — schema-qualified so no shadow table can hijack retrieval", () => {
  /**
   * The regression this pins (2026-08-07): the dev database holds BOTH
   * `agents.turicks_brain` (empty) and `brain.turicks_brain` (2,632 rows), and the
   * connection sets `search_path=agents,brain,public`. An unqualified
   * `FROM turicks_brain` therefore resolved to the empty `agents` copy, and every
   * vector search returned zero rows — reported as "no relevant results", never as
   * an error. Retrieval was dead for weeks and looked merely unhelpful.
   */
  it("qualifies every allowed table with the brain schema", () => {
    for (const table of ALLOWED_RAG_TABLES) {
      const ref = ragTableRef(table);
      expect(ref.schema).toBe("brain");
      expect(ref.table).toBe(table);
    }
  });

  it("refuses a table outside the allowlist rather than qualifying it", () => {
    expect(() => ragTableRef("agents.turicks_brain" as never)).toThrow(/not an allowed RAG table/i);
  });
});

describe("rag-search isolation guard", () => {
  it("allows the known RAG tables", () => {
    expect(() => assertAllowedRagTable("personal_rag")).not.toThrow();
    expect(() => assertAllowedRagTable("turicks_brain")).not.toThrow();
    // research_cache: Apify web-findings store (business-public, same side of the
    // ADR-013/015 firewall as turicks_brain).
    expect(() => assertAllowedRagTable("research_cache")).not.toThrow();
  });

  it("rejects any other table name (ADR-013/015 cross-store ban + SQL-injection guard)", () => {
    expect(() => assertAllowedRagTable("knowledge_entries")).toThrow(/not an allowed RAG table/i);
    expect(() => assertAllowedRagTable("personal_rag; drop table users")).toThrow();
  });

  it("exposes exactly the allowed tables", () => {
    expect([...ALLOWED_RAG_TABLES].sort()).toEqual(["brain_memories", "personal_rag", "research_cache", "turicks_brain"]);
  });
});
