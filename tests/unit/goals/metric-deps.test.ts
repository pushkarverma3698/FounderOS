/**
 * The GitHub half of the metric sources, against a fake search client: the exact query it sends,
 * how it refuses a partial answer, and how a missing token surfaces. No network, no Octokit call.
 * The database half is exercised against real Postgres in tests/integration/goals-postgres.test.ts.
 */

import { describe, it, expect, vi } from "vitest";
import { createGitHubCounts, githubClientFromEnv, type SearchClient } from "../../../src/goals/metric-deps.js";
import { MetricSourceError } from "../../../src/goals/metric-errors.js";

const SINCE = new Date("2026-09-22T09:00:00.000Z");
const UNTIL = new Date("2026-09-29T09:00:00.000Z");

function fakeClient(reply: { total_count: unknown; incomplete_results?: boolean } | Error) {
  const search = vi.fn(async (_params: { q: string; per_page: number }) => {
    if (reply instanceof Error) throw reply;
    return { data: { incomplete_results: false, ...reply } as { total_count: number; incomplete_results: boolean } };
  });
  const client: SearchClient = { rest: { search: { issuesAndPullRequests: search } } };
  return { client, search };
}

describe("createGitHubCounts — what is asked of GitHub", () => {
  it("counts merged PRs with one search over the exact window, asking for one row because only the total matters", async () => {
    const { client, search } = fakeClient({ total_count: 3 });
    const counts = createGitHubCounts(async () => client);
    await expect(counts.countMergedPrs("acme/api", SINCE, UNTIL)).resolves.toBe(3);
    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0]![0]).toEqual({
      q: "repo:acme/api is:pr is:merged merged:2026-09-22T09:00:00Z..2026-09-29T09:00:00Z",
      per_page: 1,
    });
  });

  it("counts closed issues (not PRs) the same way", async () => {
    const { client, search } = fakeClient({ total_count: 0 });
    const counts = createGitHubCounts(async () => client);
    await expect(counts.countClosedIssues("acme/api", SINCE, UNTIL)).resolves.toBe(0);
    expect(search.mock.calls[0]![0].q).toBe("repo:acme/api is:issue is:closed closed:2026-09-22T09:00:00Z..2026-09-29T09:00:00Z");
  });

  it("refuses an incomplete search rather than reporting a count it cannot vouch for", async () => {
    const { client } = fakeClient({ total_count: 1, incomplete_results: true });
    const counts = createGitHubCounts(async () => client);
    await expect(counts.countMergedPrs("acme/api", SINCE, UNTIL)).rejects.toMatchObject({
      name: "MetricSourceError",
      kind: "incomplete-results",
    });
  });

  it("refuses a total that is not a non-negative whole number", async () => {
    for (const bad of ["3", null, -1, 1.5, Number.NaN]) {
      const { client } = fakeClient({ total_count: bad });
      const counts = createGitHubCounts(async () => client);
      await expect(counts.countMergedPrs("acme/api", SINCE, UNTIL), String(bad)).rejects.toBeInstanceOf(Error);
    }
  });

  it("lets a GitHub error through untouched, so evaluateMetric can name its status", async () => {
    const boom = Object.assign(new Error("Bad credentials"), { status: 401 });
    const { client } = fakeClient(boom);
    const counts = createGitHubCounts(async () => client);
    await expect(counts.countMergedPrs("acme/api", SINCE, UNTIL)).rejects.toBe(boom);
  });

  it("never builds a search from a repo that is not a plain owner/repo, even if a bad one is stored", async () => {
    const { client, search } = fakeClient({ total_count: 1 });
    const counts = createGitHubCounts(async () => client);
    for (const repo of ["acme/api org:secret", "acme", "acme/api\nis:private"]) {
      await expect(counts.countMergedPrs(repo, SINCE, UNTIL), repo).rejects.toBeInstanceOf(Error);
    }
    expect(search).not.toHaveBeenCalled();
  });

  it("surfaces a client that could not be built (no token) without calling GitHub", async () => {
    const counts = createGitHubCounts(async () => {
      throw new MetricSourceError("no-token", "GITHUB_TOKEN not configured");
    });
    await expect(counts.countMergedPrs("acme/api", SINCE, UNTIL)).rejects.toMatchObject({ kind: "no-token" });
  });
});

describe("githubClientFromEnv", () => {
  it("throws the no-token error, naming the variable, when GITHUB_TOKEN is missing or empty", async () => {
    await expect(githubClientFromEnv({})).rejects.toMatchObject({ name: "MetricSourceError", kind: "no-token" });
    await expect(githubClientFromEnv({ GITHUB_TOKEN: "" })).rejects.toMatchObject({ kind: "no-token" });
  });

  it("builds a client with a search method when a token is present (construction makes no request)", async () => {
    const client = await githubClientFromEnv({ GITHUB_TOKEN: "not-a-real-token-just-a-shape" });
    expect(typeof client.rest.search.issuesAndPullRequests).toBe("function");
  });
});
