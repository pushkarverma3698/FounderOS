/**
 * Unit tests for GitHub read fast path.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const execute = vi.fn();
vi.mock("../../../src/tools/github.js", () => ({
  githubTool: { execute: (...args: unknown[]) => execute(...args) },
}));

const {
  parseGithubOwnerRepo,
  githubListLimit,
  tryGithubReadFastPath,
} = await import("../../../src/gateway/github-read-fast-path.js");

describe("parseGithubOwnerRepo", () => {
  it("parses owner/repo from issue list prompt", () => {
    expect(parseGithubOwnerRepo("List open issues on pushkarverma3698/FounderOS — max 5")).toEqual({
      owner: "pushkarverma3698",
      repo: "FounderOS",
    });
  });
});

describe("githubListLimit", () => {
  it("reads max N from prompt", () => {
    expect(githubListLimit("just titles, max 5.")).toBe(5);
  });
});

describe("tryGithubReadFastPath", () => {
  beforeEach(() => {
    execute.mockReset();
  });

  it("returns formatted titles for list issues request", async () => {
    execute.mockResolvedValue({
      success: true,
      data: [
        { number: 1, title: "feat: alpha" },
        { number: 2, title: "fix: beta" },
      ],
    });
    const out = await tryGithubReadFastPath(
      "List open issues on pushkarverma3698/FounderOS — just titles, max 5.",
    );
    expect(out).toContain("#1 feat: alpha");
    expect(execute).toHaveBeenCalledWith({
      action: "list_issues",
      owner: "pushkarverma3698",
      repo: "FounderOS",
    });
  });

  it("returns null for non-issue prompts", async () => {
    expect(await tryGithubReadFastPath("Write a TypeScript function to sort arrays")).toBeNull();
  });
});
