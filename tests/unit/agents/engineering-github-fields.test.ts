/**
 * Unit tests for missingGithubWriteFields — the structured-input guard that
 * rejects an incomplete github_write call BEFORE it reaches the GitHub API.
 *
 * Why this exists: the model used to call create_issue without a repo/title;
 * the call fell through to a vague GitHub 4xx, which the model then "explained
 * away" in its reply (a hallucinated success). The guard forces a precise,
 * correctable error instead, so the tool contract is structured, not guessed.
 */

import { describe, it, expect } from "vitest";
import { missingGithubWriteFields } from "../../../src/agents/agent-tools/engineering.js";

describe("missingGithubWriteFields", () => {
  // ── create_issue: owner + repo + title required ──────────────────────────────

  it("flags all three when create_issue is called with nothing", () => {
    expect(missingGithubWriteFields("create_issue", {})).toEqual(["owner", "repo", "title"]);
  });

  it("flags only the missing fields for a partial create_issue", () => {
    expect(missingGithubWriteFields("create_issue", { owner: "pushkarverma3698" })).toEqual([
      "repo",
      "title",
    ]);
  });

  it("returns empty when create_issue has owner, repo and title", () => {
    expect(
      missingGithubWriteFields("create_issue", { owner: "x", repo: "FounderOS", title: "Bug" }),
    ).toEqual([]);
  });

  // ── create_repo: only title required ─────────────────────────────────────────

  it("requires only title for create_repo", () => {
    expect(missingGithubWriteFields("create_repo", {})).toEqual(["title"]);
    expect(missingGithubWriteFields("create_repo", { title: "new-repo" })).toEqual([]);
  });

  // ── update_readme: owner + repo + content required ───────────────────────────

  it("requires owner, repo and content for update_readme", () => {
    expect(missingGithubWriteFields("update_readme", { owner: "x", repo: "y" })).toEqual([
      "content",
    ]);
    expect(
      missingGithubWriteFields("update_readme", { owner: "x", repo: "y", content: "# Hi" }),
    ).toEqual([]);
  });

  // ── Edge cases ───────────────────────────────────────────────────────────────

  it("treats empty-string and null as missing (not just undefined)", () => {
    expect(missingGithubWriteFields("create_repo", { title: "" })).toEqual(["title"]);
    expect(missingGithubWriteFields("create_repo", { title: null })).toEqual(["title"]);
  });

  it("returns no requirements for an unknown action (lets the API decide)", () => {
    expect(missingGithubWriteFields("delete_repo", {})).toEqual([]);
  });
});
