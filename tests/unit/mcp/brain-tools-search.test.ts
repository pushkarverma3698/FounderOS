/**
 * AG-025: the IDE hub's search_memory prints date · origin · project · type per hit (no more "Source: unknown")
 * and abstains on a weak top cosine.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RagHit } from "../../../src/db/rag-search.js";

const searchBrain = vi.fn();
vi.mock("../../../src/db/rag-search.js", () => ({ searchBrain: (...a: unknown[]) => searchBrain(...a) }));
vi.mock("../../../src/db/brain-ingest.js", () => ({ brainIngest: vi.fn() }));
vi.mock("../../../src/db/client.js", () => ({ db: {} }));

const { callBrainTool } = await import("../../../src/mcp/brain-tools.js");

const row = (over: Partial<RagHit> = {}): RagHit => ({
  content: "Decided to keep the screen log in screen.jsonl.",
  metadata: {},
  score: 0.03,
  cosine: 0.8,
  memory_type: "decision",
  project: "founderos",
  source: "ide_mcp",
  created_at: new Date("2026-10-06T08:00:00Z"),
  ...over,
});

const textOf = (r: Awaited<ReturnType<typeof callBrainTool>>) => r!.content[0]!.text;

describe("brain hub search_memory", () => {
  beforeEach(() => searchBrain.mockReset());

  it("renders an ide_mcp decision as '2026-10-06 · agent · founderos · decision', not 'Source: unknown'", async () => {
    searchBrain.mockResolvedValue({ hits: [row()], mode: "hybrid" });
    const text = textOf(await callBrainTool("search_memory", { query: "screen log" }));
    expect(text).toContain("2026-10-06 · agent · founderos · decision");
    expect(text).not.toContain("Source: unknown");
  });

  it("starts with 'No strong match' when the best cosine is under the abstain constant", async () => {
    searchBrain.mockResolvedValue({ hits: [row({ cosine: 0.2 }), row({ cosine: 0.1 }), row({ cosine: 0.1 })], mode: "hybrid" });
    const text = textOf(await callBrainTool("search_memory", { query: "PR 79 verdict" }));
    expect(text.startsWith('No strong match for "PR 79 verdict". Closest: 2026-10-06 · agent · founderos · decision')).toBe(true);
    expect(text.match(/--- Result/g)).toHaveLength(2);
  });
});
