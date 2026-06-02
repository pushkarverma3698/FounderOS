/**
 * Unit tests for the GitHub tool.
 * Mocks Octokit — no live API calls or GITHUB_TOKEN needed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Octokit mock — intercept at module level
const mockGetAuthenticated = vi.fn();
const mockListForAuthenticatedUser = vi.fn();
const mockListForUser = vi.fn();
const mockGetReadme = vi.fn();
const mockCreateOrUpdateFileContents = vi.fn();
const mockIssuesCreate = vi.fn();
const mockReposCreate = vi.fn();

vi.mock("octokit", () => {
  return {
    Octokit: vi.fn().mockImplementation(() => ({
      rest: {
        users: { getAuthenticated: mockGetAuthenticated },
        repos: {
          listForAuthenticatedUser: mockListForAuthenticatedUser,
          listForUser: mockListForUser,
          getReadme: mockGetReadme,
          createOrUpdateFileContents: mockCreateOrUpdateFileContents,
          createForAuthenticatedUser: mockReposCreate,
        },
        issues: { create: mockIssuesCreate },
      },
    })),
  };
});

const { githubTool } = await import("../../../src/tools/github.js");

describe("githubTool — error handling", () => {
  it("returns error when GITHUB_TOKEN is not set", async () => {
    delete process.env["GITHUB_TOKEN"];
    const result = await githubTool.execute({ action: "get_stats" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("GITHUB_TOKEN");
  });

  it("returns error for unknown action", async () => {
    process.env["GITHUB_TOKEN"] = "ghp_test";
    const result = await githubTool.execute({ action: "unknown_action" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown action");
  });
});

describe("githubTool — get_stats", () => {
  beforeEach(() => {
    process.env["GITHUB_TOKEN"] = "ghp_test";
    mockGetAuthenticated.mockResolvedValue({
      data: {
        login: "pushkarai",
        name: "Pushkar",
        bio: "Builder",
        followers: 42,
        following: 10,
        public_repos: 8,
        public_gists: 0,
        html_url: "https://github.com/pushkarai",
        avatar_url: "https://avatars.github.com/u/1",
      },
    });
  });

  it("returns profile stats", async () => {
    const result = await githubTool.execute({ action: "get_stats" });
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.login).toBe("pushkarai");
    expect(data.followers).toBe(42);
  });
});

describe("githubTool — list_repos", () => {
  beforeEach(() => {
    process.env["GITHUB_TOKEN"] = "ghp_test";
    mockListForAuthenticatedUser.mockResolvedValue({
      data: [
        {
          name: "founderos",
          full_name: "pushkarai/founderos",
          description: "AI OS",
          language: "TypeScript",
          stargazers_count: 5,
          forks_count: 1,
          private: false,
          html_url: "https://github.com/pushkarai/founderos",
        },
      ],
    });
  });

  it("lists authenticated user repos", async () => {
    const result = await githubTool.execute({ action: "list_repos" });
    expect(result.success).toBe(true);
    const data = result.data as { repos: unknown[]; count: number };
    expect(data.count).toBe(1);
    expect(data.repos[0]).toMatchObject({ name: "founderos" });
  });
});

describe("githubTool — get_readme", () => {
  beforeEach(() => {
    process.env["GITHUB_TOKEN"] = "ghp_test";
    mockGetReadme.mockResolvedValue({
      data: {
        content: Buffer.from("# Hello README").toString("base64"),
        sha: "abc123",
      },
    });
  });

  it("returns error when owner or repo is missing", async () => {
    const result = await githubTool.execute({ action: "get_readme" });
    expect(result.success).toBe(false);
  });

  it("returns decoded README content", async () => {
    const result = await githubTool.execute({
      action: "get_readme",
      owner: "pushkarai",
      repo: "founderos",
    });
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.content).toContain("Hello README");
  });
});

describe("githubTool — create_issue", () => {
  beforeEach(() => {
    process.env["GITHUB_TOKEN"] = "ghp_test";
    mockIssuesCreate.mockResolvedValue({
      data: { number: 42, html_url: "https://github.com/pushkarai/founderos/issues/42", title: "Bug" },
    });
  });

  it("returns error when owner, repo, or title is missing", async () => {
    const result = await githubTool.execute({ action: "create_issue", owner: "x" });
    expect(result.success).toBe(false);
  });

  it("creates an issue successfully", async () => {
    const result = await githubTool.execute({
      action: "create_issue",
      owner: "pushkarai",
      repo: "founderos",
      title: "Bug: X is broken",
    });
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.issue_number).toBe(42);
  });
});
