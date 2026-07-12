/**
 * Unit tests — planner prompt routing rules (pure string build).
 * ================================================================
 * 2026-07-11 incidents 1022a8a5/97c82adf: "what schedulers run in FounderOS"
 * planned personal.list_dir over ~/Projects instead of engineering github_read
 * on the founderos repo. The planner prompt is THE router in v3 — the
 * self-knowledge rule below is the routing contract for those questions.
 */

import { describe, it, expect } from "vitest";
import { buildPlannerPrompt, type WorkerCatalogEntry } from "../../../src/kernel/planner.js";

const catalog: WorkerCatalogEntry[] = [
  { id: "engineering", description: "code and repo work", toolNames: ["github_read"], gatedToolNames: [] },
  { id: "personal", description: "founder files", toolNames: ["list_dir", "read_file"], gatedToolNames: [] },
];

describe("buildPlannerPrompt — FounderOS self-knowledge routing", () => {
  it("routes questions about FounderOS itself to engineering github_read, never personal file tools", () => {
    const prompt = buildPlannerPrompt(catalog);
    expect(prompt).toContain("Questions about FounderOS itself");
    expect(prompt).toContain("github_read");
    expect(prompt).toContain("/opt/founderos");
    expect(prompt).toMatch(/never.*(list_dir|read_file|personal file tools)/i);
  });

  it("keeps the founder-context rule (read_context/search_memory) intact", () => {
    const prompt = buildPlannerPrompt(catalog);
    expect(prompt).toContain("read_context");
    expect(prompt).toContain("search_memory");
  });
});
