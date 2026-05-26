/**
 * Unit tests for critic.ts
 * Tests: afterCriticEdge routing logic (pure function — no LLM calls)
 */

import { describe, it, expect } from "vitest";
import { afterCriticEdge } from "../../src/agents/critic.js";
import type { CritiqueRecord } from "../../src/agents/state.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRecord(result: "APPROVED" | "NEEDS_REVISION", violations: string[] = []): CritiqueRecord {
  return {
    result,
    notes: result === "APPROVED" ? "Looks good" : "Issues found",
    critic_model: "claude-haiku-4-5",
    timestamp: new Date().toISOString(),
    rule_violations: violations,
  };
}

function makeState(overrides: {
  critiques: CritiqueRecord[];
  revision_count: number;
  max_revisions: number;
}) {
  return overrides;
}

// ── afterCriticEdge tests ─────────────────────────────────────────────────────

describe("afterCriticEdge", () => {
  it("routes to hitl when last critique is APPROVED", () => {
    const state = makeState({
      critiques: [makeRecord("NEEDS_REVISION"), makeRecord("APPROVED")],
      revision_count: 2,
      max_revisions: 3,
    });
    expect(afterCriticEdge(state)).toBe("hitl");
  });

  it("routes to generator when NEEDS_REVISION and under revision limit", () => {
    const state = makeState({
      critiques: [makeRecord("NEEDS_REVISION", ["banned_phrase"])],
      revision_count: 1,
      max_revisions: 3,
    });
    expect(afterCriticEdge(state)).toBe("generator");
  });

  it("routes to hitl (escalation) when NEEDS_REVISION and revision_count == max_revisions", () => {
    const state = makeState({
      critiques: [makeRecord("NEEDS_REVISION", ["word_count"])],
      revision_count: 2,
      max_revisions: 2,
    });
    expect(afterCriticEdge(state)).toBe("hitl");
  });

  it("routes to hitl (escalation) when revision_count exceeds max_revisions", () => {
    const state = makeState({
      critiques: [makeRecord("NEEDS_REVISION")],
      revision_count: 5,
      max_revisions: 2,
    });
    expect(afterCriticEdge(state)).toBe("hitl");
  });

  it("routes to hitl when critiques array is empty (no critique = something wrong)", () => {
    const state = makeState({
      critiques: [],
      revision_count: 0,
      max_revisions: 3,
    });
    expect(afterCriticEdge(state)).toBe("hitl");
  });

  it("uses the LAST critique only (not earlier ones)", () => {
    // First critique was APPROVED, but latest is NEEDS_REVISION under limit
    const state = makeState({
      critiques: [
        makeRecord("APPROVED"),
        makeRecord("NEEDS_REVISION", ["missing_specific_reference"]),
      ],
      revision_count: 1,
      max_revisions: 3,
    });
    // Latest is NEEDS_REVISION, revision_count=1 < max_revisions=3 → retry
    expect(afterCriticEdge(state)).toBe("generator");
  });

  it("exactly at max_revisions=1 → escalates immediately after first failed critique", () => {
    const state = makeState({
      critiques: [makeRecord("NEEDS_REVISION", ["no_cta"])],
      revision_count: 1,
      max_revisions: 1,
    });
    expect(afterCriticEdge(state)).toBe("hitl");
  });

  it("revision_count=0 with NEEDS_REVISION routes to generator (allows first retry)", () => {
    const state = makeState({
      critiques: [makeRecord("NEEDS_REVISION", ["filler_phrase"])],
      revision_count: 0,
      max_revisions: 2,
    });
    // revision_count=0, max=2, 0 < 2 → retry
    expect(afterCriticEdge(state)).toBe("generator");
  });
});
