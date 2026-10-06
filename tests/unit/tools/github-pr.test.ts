/**
 * get_pr gives the agent what a merge verdict needs in one call.
 * Regression for 2026-10-06: asked "is PR 79 ready?", the bot had no PR read
 * and answered "insufficient data" while pr-brain's verdict sat in the comments.
 */

import { describe, it, expect, vi } from "vitest";
import type { Octokit } from "octokit";
import { getPullRequest, listPullRequests } from "../../../src/tools/github-pr.js";

function fakeOctokit(over: { patch?: string; comments?: Array<{ body: string }> } = {}) {
  const pullsGet = vi.fn().mockResolvedValue({
    data: {
      number: 79, title: "feat: BSUID", state: "open", merged: false, draft: true,
      head: { ref: "task/issue-76", sha: "a1279a4da5c63ffd" }, base: { ref: "beta" },
      user: { login: "bot" }, mergeable: true, mergeable_state: "clean",
      created_at: "2026-10-03", updated_at: "2026-10-04", html_url: "https://x/pull/79", body: "Closes #76",
    },
  });
  const comments = (over.comments ?? [
    { body: "❌ GATE FAILED — Changes Requested\nBLOCKER: missing unique constraint" },
    { body: "<!-- brain-reviewed: a1279a4 -->" },
  ]).map((c, i) => ({ ...c, user: { login: "pushkarverma3698" }, created_at: `2026-10-0${i + 1}` }));
  const octokit = {
    rest: {
      pulls: {
        get: pullsGet,
        listFiles: vi.fn().mockResolvedValue({
          data: [{ filename: "src/webhooks.js", status: "modified", additions: 10, deletions: 2, patch: over.patch ?? "@@ -1 +1 @@\n-a\n+b" }],
        }),
        listReviews: vi.fn().mockResolvedValue({ data: [] }),
        list: vi.fn().mockResolvedValue({
          data: [{ number: 79, title: "feat: BSUID", draft: true, head: { ref: "h" }, base: { ref: "beta" }, user: { login: "bot" }, updated_at: "d", html_url: "u" }],
        }),
      },
      issues: { listComments: vi.fn().mockResolvedValue({ data: comments }) },
      checks: {
        listForRef: vi.fn().mockResolvedValue({ data: { check_runs: [{ name: "Tests", status: "completed", conclusion: "success" }] } }),
      },
    },
  };
  return { octokit: octokit as unknown as Octokit, pullsGet, listForRef: octokit.rest.checks.listForRef };
}

describe("getPullRequest", () => {
  it("returns draft state, CI, the diff and pr-brain's verdict", async () => {
    const { octokit, listForRef } = fakeOctokit();
    const res = await getPullRequest(octokit, "OplifyMessage", "oplify-messaging-api", 79);
    expect(res.success).toBe(true);
    const d = res.data as Record<string, unknown> & { latest_comments: Array<{ body: string }>; files: Array<{ patch: string }> };
    expect(d["draft"]).toBe(true);
    expect(d["checks"]).toEqual([{ name: "Tests", status: "completed", conclusion: "success" }]);
    expect(d.files[0]!.patch).toContain("+b");
    expect(d.latest_comments).toHaveLength(1); // marker-only comment dropped
    expect(d.latest_comments[0]!.body).toContain("GATE FAILED");
    expect(listForRef).toHaveBeenCalledWith(expect.objectContaining({ ref: "a1279a4da5c63ffd" }));
  });

  it("caps a huge diff so one call cannot flood the context", async () => {
    const { octokit } = fakeOctokit({ patch: "x".repeat(50_000) });
    const res = await getPullRequest(octokit, "o", "r", 79);
    const patch = (res.data as { files: Array<{ patch: string }> }).files[0]!.patch;
    expect(patch.length).toBeLessThan(6_100);
    expect(patch).toContain("chars cut");
  });

  it("keeps only the latest six meaningful comments", async () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ body: `comment ${i}` }));
    const { octokit } = fakeOctokit({ comments: many });
    const res = await getPullRequest(octokit, "o", "r", 79);
    const d = res.data as { latest_comments: Array<{ body: string }>; comments_total: number };
    expect(d.latest_comments.map((c) => c.body)).toEqual(["comment 3", "comment 4", "comment 5", "comment 6", "comment 7", "comment 8"]);
    expect(d.comments_total).toBe(9);
  });
});

describe("getPullRequest — CI unreadable", () => {
  it("still returns the PR and says why checks are missing", async () => {
    const { octokit, listForRef } = fakeOctokit();
    listForRef.mockRejectedValueOnce(new Error("Resource not accessible by personal access token"));
    const res = await getPullRequest(octokit, "o", "r", 79);
    expect(res.success).toBe(true);
    expect((res.data as { checks: unknown }).checks).toBe("unavailable: Resource not accessible by personal access token");
  });
});

describe("listPullRequests", () => {
  it("lists open PRs with their draft flag", async () => {
    const { octokit } = fakeOctokit();
    const res = await listPullRequests(octokit, "o", "r");
    expect(res.data).toEqual([expect.objectContaining({ number: 79, draft: true, base: "beta" })]);
  });
});
