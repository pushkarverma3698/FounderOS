/**
 * J3 (2026-10-08): every open PR the founder asks about must reach the model with its number and
 * title. A full list_prs page (30 rows, the per_page cap) must fit under the per-result clamp, so the
 * clamp never drops rows from the middle of the list.
 */
import { describe, expect, it, vi } from "vitest";
import { clampToolOutput, TOOL_OUTPUT_MAX_CHARS } from "../../../src/kernel/index.js";

const rows = Array.from({ length: 30 }, (_, i) => ({
  number: 1000 + i,
  title: `feat(kernel): a realistic conventional-commit PR title of some length (AG-0${i})`,
  draft: i % 2 === 0,
  head: `feat/some-branch-name-${i}`,
  base: "beta",
  author: "pushkarverma3698",
  url: `https://github.com/pushkarverma3698/FounderOS/pull/${1000 + i}`,
  updated_at: "2026-10-08T18:37:00Z",
  head_sha: "d328d636",
  ci: "red",
  failing: ["gate", "verify-architecture"],
}));
vi.mock("../../../src/tools/github.js", () => ({
  githubTool: { execute: async () => ({ success: true, data: rows }), description: "gh" },
}));

const { githubRead } = await import("../../../src/agents/agent-tools/engineering.js");

describe("github_read list_prs output", () => {
  it("a 30-row page passes the clamp untouched, every number and title intact", async () => {
    const out = String(await githubRead.invoke({ action: "list_prs", owner: "o", repo: "r" }, { configurable: { thread_id: "t" } }));
    expect(out.length).toBeLessThan(TOOL_OUTPUT_MAX_CHARS);
    const seen = clampToolOutput(out);
    expect(seen).toBe(out);
    for (const r of rows) expect(seen).toContain(`"number":${r.number},"title":"${r.title}"`);
  });
});
