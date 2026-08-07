/** Unit test for ContextComposer Engine */
import { describe, it, expect } from "vitest";
import {
  calculateMultiSignalScore,
  rankMemoryItems,
  composeTurnContext,
} from "../../../src/kernel/context-composer.js";

describe("ContextComposer Engine", () => {
  it("calculates multi-signal memory score with time decay", () => {
    const freshItem = { id: "1", layer: 3 as const, content: "x", cosineSim: 0.9, timestamp: Date.now() };
    const staleItem = { id: "2", layer: 3 as const, content: "y", cosineSim: 0.9, timestamp: Date.now() - 1000 * 60 * 60 * 72 };

    expect(calculateMultiSignalScore(freshItem)).toBeGreaterThan(calculateMultiSignalScore(staleItem));
  });

  it("ranks memory items by relevance score descending", () => {
    const items = [
      { id: "low", layer: 3 as const, content: "low", cosineSim: 0.2 },
      { id: "high", layer: 3 as const, content: "high", cosineSim: 0.95 },
    ];
    const ranked = rankMemoryItems(items);
    expect(ranked[0]?.id).toBe("high");
  });

  it("composes 5-layer context bounded by character budget", () => {
    const context = composeTurnContext({
      workingMemoryText: "User asked for status",
      workspaceStateText: "Branch: gemini/antigravityChanges",
      recentEvidenceText: "Commit 4a86de9 deployed",
      distilledRagText: "FounderOS v3 running",
      entityGraphTriples: [{ subject: "FounderOS", predicate: "uses", object: "LangGraph", confidence: 1.0 }],
      maxTokens: 50,
    });

    expect(context).toContain("## Layer 0: Current Working Conversation");
    expect(context).toContain("[...Context truncated to fit token budget...]");
  });
});
