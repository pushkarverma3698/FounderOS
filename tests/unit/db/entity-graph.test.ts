/** Unit test for Cognee Entity-Graph Memory RAG */
import { describe, it, expect } from "vitest";
import {
  EntityGraphMemory,
  extractHeuristicTriples,
  formatGraphContext,
} from "../../../src/db/entity-graph.js";

describe("Cognee Entity-Graph Memory Engine", () => {
  it("traverses multi-hop entity relationships correctly", () => {
    const graph = new EntityGraphMemory();
    graph.addTriple("FounderOS", "requires", "PostgreSQL");
    graph.addTriple("PostgreSQL", "uses extension", "pgvector");
    graph.addTriple("pgvector", "stores", "turicks_brain");

    const triples = graph.queryGraph("FounderOS", 2);

    expect(triples.length).toBe(3);
    expect(triples.some((t) => t.subject === "FounderOS" && t.object === "PostgreSQL")).toBe(true);
    expect(triples.some((t) => t.subject === "PostgreSQL" && t.object === "pgvector")).toBe(true);
  });

  it("extracts heuristic triples from markdown text", () => {
    const markdown = `- FounderOS uses PostgreSQL\n- PostgreSQL depends on pgvector\n`;
    const triples = extractHeuristicTriples(markdown);

    expect(triples.length).toBe(2);
    expect(triples[0]?.subject).toBe("FounderOS");
    expect(triples[0]?.predicate).toBe("uses");
    expect(triples[0]?.object).toBe("PostgreSQL");
  });

  it("formats entity triples into LLM prompt context block", () => {
    const formatted = formatGraphContext([
      { subject: "FounderOS", predicate: "requires", object: "LangGraph", confidence: 1.0 },
    ]);

    expect(formatted).toContain("### Knowledge Entity Graph Relationships");
    expect(formatted).toContain("• [FounderOS] ──requires──► [LangGraph]");
  });
});
