/**
 * Live QA 2026-10-09: /where printed "Left: 38 open issues (none 38)". "none" is the label bucket for issues that
 * carry no priority, so a repo that uses no priority labels printed a parenthesis that says nothing.
 */
import { describe, it, expect } from "vitest";
import { renderRepoSection } from "../../../src/tools/repo-status-render.js";
import type { RepoSummary } from "../../../src/tools/repo-status.js";

const summary = (byPriority: Record<string, number>, total: number): RepoSummary => ({
  slug: "owner/repo",
  done: { count: 0, top: [] },
  inFlight: { openPrs: [], agentIssues: [] },
  left: { total, byPriority },
  blocked: { issues: [], failingPrs: [] },
});

describe("renderRepoSection — the Left line", () => {
  it("prints no parenthesis when no issue carries a priority", () => {
    const text = renderRepoSection(summary({ none: 38 }, 38));
    expect(text).toContain("Left: 38 open issues\n");
    expect(text).not.toContain("none");
  });

  it("names the priorities that exist and calls the rest unprioritised, never 'none'", () => {
    const text = renderRepoSection(summary({ P1: 2, P0: 1, none: 5 }, 8));
    expect(text).toContain("Left: 8 open issues (P0 1, P1 2, 5 unprioritised)");
    expect(text).not.toContain("none");
  });

  it("keeps a priority-only breakdown as it was", () => {
    expect(renderRepoSection(summary({ P0: 1, P2: 3 }, 4))).toContain("Left: 4 open issues (P0 1, P2 3)");
  });
});
