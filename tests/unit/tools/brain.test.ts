/**
 * Unit tests for Brain Tool Jev AI pre-filtering (src/tools/brain.ts).
 */
import { describe, it, expect } from "vitest";
import { searchTuricksBrainTool, turicksBrainPreFilter } from "../../../src/tools/brain.js";

describe("Turicks Brain Tool — Jev AI Context Pre-Filtering", () => {
  it("pre-filters RAG context chunks by removing low relevance and noise", () => {
    const rawHits = [
      { text: "Valid decision record for FounderOS architecture", score: 0.95 },
      { text: "Unrelated noise", score: 0.01 },
    ];
    const filtered = turicksBrainPreFilter(rawHits);
    expect(filtered.filteredCount).toBe(1);
    expect(filtered.filtered[0]!.text).toBe("Valid decision record for FounderOS architecture");
  });

  it("exports UnifiedTool search_turicks_brain tool with correct name and schema", () => {
    expect(searchTuricksBrainTool.name).toBe("search_turicks_brain");
    expect(searchTuricksBrainTool.input_schema?.required).toContain("query");
  });
});
