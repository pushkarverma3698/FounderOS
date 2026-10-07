/**
 * AG-025: every brain hit shows date, origin, project and type; a weak top hit abstains.
 */
import { describe, it, expect } from "vitest";
import {
  BRAIN_ABSTAIN_SIMILARITY,
  hitHeader,
  hitOrigin,
  renderWithAbstain,
} from "../../../src/db/brain-hit-view.js";
import { renderRagSuccess } from "../../../src/db/retrieval-result.js";
import type { RagHit } from "../../../src/db/rag-search.js";

const agentRow = (over: Partial<RagHit> = {}): RagHit => ({
  content: "Decided: screen log lives in screen.jsonl.",
  metadata: {},
  score: 0.8,
  cosine: 0.8,
  memory_type: "decision",
  project: "founderos",
  source: "ide_mcp",
  created_at: new Date("2026-10-06T08:00:00Z"),
  ...over,
});

describe("hitOrigin / hitHeader", () => {
  it("renders an ide_mcp decision as date · agent · project · type", () => {
    expect(hitHeader(agentRow())).toBe("2026-10-06 · agent · founderos · decision");
  });

  it("prefers metadata.origin, then docs for source_path rows, then the raw source", () => {
    expect(hitOrigin(agentRow({ metadata: { origin: "mac-claude" } }))).toBe("mac-claude");
    expect(hitOrigin(agentRow({ source: "brain-sync", metadata: { source_path: "docs/a.md" } }))).toBe("docs");
    expect(hitOrigin(agentRow({ source: "telegram" }))).toBe("telegram");
  });

  it("says 'no project' and 'unknown date' instead of hiding the gap", () => {
    expect(hitHeader(agentRow({ project: null, created_at: null }))).toBe("unknown date · agent · no project · decision");
  });

  it("accepts created_at as an ISO string", () => {
    expect(hitHeader(agentRow({ created_at: "2026-10-05T08:00:00.000Z" })).startsWith("2026-10-05")).toBe(true);
  });
});

describe("renderWithAbstain", () => {
  const rows = [agentRow({ cosine: BRAIN_ABSTAIN_SIMILARITY - 0.05 }), agentRow({ cosine: 0.4 }), agentRow({ cosine: 0.3 })];

  it("starts with 'No strong match' and lists at most 2 hits when the best cosine is under the constant", () => {
    const out = renderWithAbstain(rows, "PR 79 verdict", (h, i) => `#${i + 1} ${h.content}`);
    expect(out.startsWith('No strong match for "PR 79 verdict". Closest: 2026-10-06 · agent · founderos · decision')).toBe(true);
    expect(out.match(/^#\d/gm)).toHaveLength(2);
  });

  it("uses the best cosine, not the first hit's", () => {
    const out = renderWithAbstain([agentRow({ cosine: 0.3 }), agentRow({ cosine: 0.9 })], "q", (h) => h.content);
    expect(out.startsWith("No strong match")).toBe(false);
  });

  it("does not abstain when no hit carries a cosine (keyword-only, RAGFlow): it cannot tell", () => {
    const noCos = [agentRow({ cosine: undefined, score: 0.1 })];
    expect(renderWithAbstain(noCos, "q", (h) => h.content).startsWith("No strong match")).toBe(false);
  });

  it("ignores the term-overlap score: a keyword-only hit with score 1 does not rescue a weak vector hit", () => {
    const hits = [agentRow({ cosine: 0.2, score: 0.2 }), agentRow({ cosine: undefined, score: 1 })];
    expect(renderWithAbstain(hits, "q", (h) => h.content).startsWith("No strong match")).toBe(true);
  });
});

describe("renderRagSuccess", () => {
  it("prints the header line for a brain_memories hit and abstains when weak", () => {
    const weak = renderRagSuccess(
      { hits: [agentRow({ cosine: 0.2 })], mode: "hybrid" },
      "what did we decide",
      "Turicks Brain",
      "source_path",
    );
    expect(weak.startsWith('No strong match for "what did we decide". Closest: 2026-10-06 · agent · founderos · decision')).toBe(true);
    const strong = renderRagSuccess({ hits: [agentRow()], mode: "hybrid" }, "q", "Turicks Brain", "source_path");
    expect(strong).toContain("2026-10-06 · agent · founderos · decision");
    expect(strong).not.toContain("No strong match");
  });

  it("leaves non-brain hits (no created_at/memory_type) rendering as before", () => {
    const out = renderRagSuccess(
      { hits: [{ content: "x", metadata: { source_path: "a.md" }, score: 0.1 }], mode: "hybrid" },
      "q",
      "Research Cache",
      "source_path",
    );
    expect(out).toContain("[a.md]");
    expect(out).not.toContain("No strong match");
  });
});
