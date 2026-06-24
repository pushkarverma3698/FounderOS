import { describe, it, expect } from "vitest";
import { assertAllowedRagTable, ALLOWED_RAG_TABLES } from "../../../src/db/rag-search.js";

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
    expect([...ALLOWED_RAG_TABLES].sort()).toEqual(["personal_rag", "research_cache", "turicks_brain"]);
  });
});
