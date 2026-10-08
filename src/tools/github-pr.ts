/**
 * Pull-request reads for the github tool.
 *
 * Without these the engineering agent could not see a PR at all: on 2026-10-06
 * the founder asked "review PR 79, is it ready to merge?" and the bot answered
 * "insufficient data" while pr-brain's verdict (changes requested) sat in the
 * PR's own comments. get_pr returns everything a merge verdict needs in one
 * call: state, draft flag, CI, changed files with a capped diff, reviews and
 * the latest comments.
 */

import type { Octokit } from "octokit";
import type { ToolResult } from "./index.js";
import { listResult } from "./list-truncation.js";

/** Caps keep one get_pr result small enough for a multi-step chain. */
const MAX_BODY = 1_500;
const MAX_COMMENT = 1_200;
const MAX_COMMENTS = 6;
const MAX_FILES = 40;
const MAX_PATCH_TOTAL = 6_000;

function cap(text: string | null | undefined, max: number): string {
  const t = (text ?? "").trim();
  return t.length > max ? `${t.slice(0, max)}…[${t.length - max} chars cut]` : t;
}

type CheckRun = { name: string; status: string; conclusion: string | null };
const PASSING = new Set(["success", "skipped", "neutral"]);

/**
 * One CI verdict for a head commit. A check name passes when any of its runs passed, so a cancelled
 * re-run next to a green one does not read as red; it fails when a run finished failing and none passed.
 */
export function summarizeChecks(runs: CheckRun[]): { ci: "green" | "red" | "pending" | "none"; failing?: string[] } {
  if (runs.length === 0) return { ci: "none" };
  const byName = new Map<string, CheckRun[]>();
  for (const r of runs) byName.set(r.name, [...(byName.get(r.name) ?? []), r]);
  const failing: string[] = [];
  let pending = false;
  for (const [name, rs] of byName) {
    if (rs.some((r) => r.status === "completed" && PASSING.has(r.conclusion ?? ""))) continue;
    if (rs.some((r) => r.status !== "completed")) pending = true;
    else if (rs.some((r) => r.conclusion !== "cancelled")) failing.push(name);
    else pending = true; // only cancelled runs: no verdict yet
  }
  if (failing.length > 0) return { ci: "red", failing };
  return { ci: pending ? "pending" : "green" };
}

async function ciFor(octokit: Octokit, owner: string, repo: string, sha: string) {
  return octokit.rest.checks
    .listForRef({ owner, repo, ref: sha, per_page: 100 })
    .then(({ data }) => summarizeChecks(data.check_runs))
    .catch((err: unknown) => ({ ci: `unavailable: ${err instanceof Error ? err.message : String(err)}` })); // allow-failopen: CI is reported as unavailable with its reason, never as passing
}

/** Open PRs with a CI verdict each, or (state "merged") PRs merged since an ISO time with merge time and SHA. */
export async function listPullRequests(
  octokit: Octokit,
  owner: string,
  repo: string,
  opts: { state?: "open" | "merged"; since?: string } = {},
): Promise<ToolResult> {
  type Pr = { number: number; title: string; draft?: boolean; head: { ref: string }; base: { ref: string }; user: { login: string } | null; html_url: string };
  const row = (p: Pr) => ({
    number: p.number,
    title: p.title,
    draft: p.draft ?? false,
    head: p.head.ref,
    base: p.base.ref,
    author: p.user?.login ?? "unknown",
    url: p.html_url,
  });
  if (opts.state === "merged") {
    const { data } = await octokit.rest.pulls.list({ owner, repo, state: "closed", per_page: 50, sort: "updated", direction: "desc" });
    const since = opts.since ? Date.parse(opts.since) : 0;
    const merged = data
      .filter((p) => p.merged_at && Date.parse(p.merged_at) >= since)
      .map((p) => ({ ...row(p), merged_at: p.merged_at, merge_sha: (p.merge_commit_sha ?? "").slice(0, 8) }));
    return listResult(merged, 50);
  }
  const { data } = await octokit.rest.pulls.list({ owner, repo, state: "open", per_page: 30, sort: "updated", direction: "desc" });
  const rows = await Promise.all(
    data.map(async (p) => ({ ...row(p), updated_at: p.updated_at, head_sha: p.head.sha?.slice(0, 8), ...(await ciFor(octokit, owner, repo, p.head.sha)) })),
  );
  return listResult(rows, 30);
}

export async function getPullRequest(octokit: Octokit, owner: string, repo: string, number: number): Promise<ToolResult> {
  const [{ data: pr }, { data: files }, { data: reviews }, { data: comments }] = await Promise.all([
    octokit.rest.pulls.get({ owner, repo, pull_number: number }),
    octokit.rest.pulls.listFiles({ owner, repo, pull_number: number, per_page: 100 }),
    octokit.rest.pulls.listReviews({ owner, repo, pull_number: number, per_page: 50 }),
    octokit.rest.issues.listComments({ owner, repo, issue_number: number, per_page: 100 }),
  ]);
  // A token without checks:read must not cost the whole PR read; the reply then says why CI is missing.
  const checks = await octokit.rest.checks
    .listForRef({ owner, repo, ref: pr.head.sha, per_page: 50 })
    .then(({ data }) => data.check_runs.map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion })))
    .catch((err: unknown) => `unavailable: ${err instanceof Error ? err.message : String(err)}`); // allow-failopen: CI state is reported as unavailable with its reason, never as passing

  let patchBudget = MAX_PATCH_TOTAL;
  const changedFiles = files.slice(0, MAX_FILES).map((f) => {
    const patch = f.patch ?? "";
    const take = Math.max(0, Math.min(patch.length, patchBudget));
    patchBudget -= take;
    return {
      file: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      patch: take === 0 ? "(diff omitted: size cap reached)" : cap(patch, take),
    };
  });

  // Bot markers like "<!-- brain-reviewed: sha -->" carry no verdict text; drop them.
  const meaningful = comments.filter((c) => (c.body ?? "").replace(/<!--[\s\S]*?-->/g, "").trim().length > 0);

  return {
    success: true,
    data: {
      number: pr.number,
      title: pr.title,
      state: pr.merged ? "merged" : pr.state,
      draft: pr.draft ?? false,
      head: pr.head.ref,
      head_sha: pr.head.sha.slice(0, 8),
      base: pr.base.ref,
      author: pr.user?.login ?? "unknown",
      mergeable: pr.mergeable,
      mergeable_state: pr.mergeable_state,
      created_at: pr.created_at,
      updated_at: pr.updated_at,
      url: pr.html_url,
      body: cap(pr.body, MAX_BODY),
      ...(typeof checks === "string" ? { ci: checks } : summarizeChecks(checks)), // same verdict list_prs gives
      checks,
      files_changed: files.length,
      files: changedFiles,
      reviews: reviews.map((r) => ({ author: r.user?.login ?? "unknown", state: r.state, at: r.submitted_at, body: cap(r.body, MAX_COMMENT) })),
      latest_comments: meaningful.slice(-MAX_COMMENTS).map((c) => ({
        author: c.user?.login ?? "unknown",
        at: c.created_at,
        body: cap(c.body, MAX_COMMENT),
      })),
      comments_total: meaningful.length,
    },
  };
}
