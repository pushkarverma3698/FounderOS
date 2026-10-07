/**
 * list_issues must not return pull requests. GitHub's issues.listForRepo returns PRs
 * too (items carrying a `pull_request` field); the tool has to drop them.
 * Mocks Octokit — no live API calls.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockListForRepo = vi.fn();

vi.mock("octokit", () => ({
  Octokit: vi.fn().mockImplementation(() => ({
    rest: { issues: { listForRepo: mockListForRepo } },
  })),
}));

const { githubTool } = await import("../../../src/tools/github.js");

describe("githubTool — list_issues excludes pull requests", () => {
  beforeEach(() => {
    process.env["GITHUB_TOKEN"] = "ghp_test";
    mockListForRepo.mockReset();
    mockListForRepo.mockResolvedValue({
      data: [
        {
          number: 11,
          title: "Real issue",
          state: "open",
          labels: [{ name: "bug" }],
          created_at: "2026-10-01T00:00:00Z",
          updated_at: "2026-10-02T00:00:00Z",
          html_url: "https://github.com/o/r/issues/11",
        },
        {
          number: 12,
          title: "A pull request",
          state: "open",
          labels: [],
          created_at: "2026-10-01T00:00:00Z",
          updated_at: "2026-10-03T00:00:00Z",
          html_url: "https://github.com/o/r/pull/12",
          pull_request: { url: "https://api.github.com/repos/o/r/pulls/12" },
        },
      ],
    });
  });

  it("returns only the issue, not the item carrying pull_request", async () => {
    const result = await githubTool.execute({ action: "list_issues", owner: "o", repo: "r" });
    expect(result.success).toBe(true);
    const data = result.data as Array<{ number: number; title: string }>;
    expect(data).toHaveLength(1);
    expect(data[0]!.number).toBe(11);
    expect(data.map((i) => i.number)).not.toContain(12);
  });
});
