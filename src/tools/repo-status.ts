/**
 * FounderOS — repo status ("where are we")
 * ========================================
 * Zero-LLM, zero-DB: GitHub REST data -> per-repo summary. The summary functions are pure
 * (tested with fixtures); `fetchRepoStatus` is the only part that touches the network.
 * Every number the founder sees comes straight from these API payloads.
 */

import { Octokit } from "octokit";
import { DISPATCH_REPO_ALLOWLIST } from "./dispatch-repos.js";

const WEEK_MS = 7 * 86_400_000;
const MAX_PAGES = 5; // 500 items per list: enough for these repos, bounded for the rate limit

export interface RawLabel { name?: string }
export interface RawCheck { conclusion: string | null }
export interface RawMergedPr { number: number; title: string; merged_at: string | null; html_url: string }
export interface RawOpenPr { number: number; title: string; html_url: string; draft: boolean; checks: RawCheck[] }
export interface RawIssue {
  number: number;
  title: string;
  html_url: string;
  labels: RawLabel[];
  pull_request?: unknown;
}
export interface RawRepoData {
  slug: string;
  mergedPrs: RawMergedPr[];
  openPrs: RawOpenPr[];
  openIssues: RawIssue[];
}

export interface Item { number: number; title: string; url: string }
export interface RepoSummary {
  slug: string;
  done: { count: number; top: Item[] };
  inFlight: { openPrs: (Item & { draft: boolean })[]; agentIssues: Item[] };
  left: { total: number; byPriority: Record<string, number> };
  blocked: { issues: Item[]; failingPrs: Item[] };
}

const FAILING = new Set(["failure", "timed_out", "action_required", "startup_failure"]);

/** True when any finished check run failed. Pending runs (null conclusion) are not failures. */
export function failingChecks(checks: readonly RawCheck[]): boolean {
  return checks.some((c) => c.conclusion !== null && FAILING.has(c.conclusion));
}

const names = (labels: readonly RawLabel[]): string[] => labels.map((l) => (l.name ?? "").toLowerCase());
const item = (n: { number: number; title: string; html_url: string }): Item => ({
  number: n.number,
  title: n.title,
  url: n.html_url,
});

function priorityOf(labels: readonly RawLabel[]): string {
  for (const raw of labels) {
    const name = (raw.name ?? "").trim();
    const m = /^priority\s*[:/-]?\s*(.+)$/i.exec(name) ?? /^(p[0-4])$/i.exec(name);
    if (m?.[1]) return m[1].toUpperCase();
  }
  return "none";
}

export function summarizeRepo(raw: RawRepoData, now: number = Date.now()): RepoSummary {
  const merged = raw.mergedPrs
    .filter((p) => p.merged_at !== null && now - Date.parse(p.merged_at) <= WEEK_MS)
    .sort((a, b) => Date.parse(b.merged_at as string) - Date.parse(a.merged_at as string));

  const issues = raw.openIssues.filter((i) => !i.pull_request);
  const isBlocked = (i: RawIssue) => names(i.labels).some((n) => n === "agent:needs-brief" || n === "agent:blocked");
  const byPriority: Record<string, number> = {};
  for (const i of issues) {
    const p = priorityOf(i.labels);
    byPriority[p] = (byPriority[p] ?? 0) + 1;
  }

  return {
    slug: raw.slug,
    done: { count: merged.length, top: merged.slice(0, 3).map(item) },
    inFlight: {
      openPrs: raw.openPrs.map((p) => ({ ...item(p), draft: p.draft })),
      agentIssues: issues.filter((i) => !isBlocked(i) && names(i.labels).some((n) => n.startsWith("agent:"))).map(item),
    },
    left: { total: issues.length, byPriority },
    blocked: {
      issues: issues.filter(isBlocked).map(item),
      failingPrs: raw.openPrs.filter((p) => failingChecks(p.checks)).map(item),
    },
  };
}

export type RepoArg = { ok: true; repos: readonly string[] } | { ok: false; valid: readonly string[] };

/** "" -> all repos; a name (case-insensitive, exact or unique substring of the repo half) -> that repo. */
export function resolveRepoArg(arg: string, repos: readonly string[]): RepoArg {
  const q = arg.trim().toLowerCase();
  if (!q) return { ok: true, repos };
  const nameOf = (s: string) => (s.split("/")[1] ?? s).toLowerCase();
  const exact = repos.filter((s) => nameOf(s) === q || s.toLowerCase() === q);
  if (exact.length === 1) return { ok: true, repos: exact };
  const partial = repos.filter((s) => nameOf(s).includes(q));
  if (partial.length === 1) return { ok: true, repos: partial };
  return { ok: false, valid: repos };
}

export interface RepoStatusView {
  summaries: RepoSummary[];
  unreachable: { repo: string; error: string }[];
}

async function fetchOne(octokit: Octokit, slug: string): Promise<RawRepoData> {
  const [owner, repo] = slug.split("/") as [string, string];
  const since = Date.now() - WEEK_MS;

  const openIssues = (await octokit.paginate(octokit.rest.issues.listForRepo, {
    owner, repo, state: "open", per_page: 100,
  })) as RawIssue[];

  const pulls = await octokit.paginate(octokit.rest.pulls.list, { owner, repo, state: "open", per_page: 100 });
  const openPrs: RawOpenPr[] = await Promise.all(
    pulls.slice(0, MAX_PAGES * 20).map(async (p) => {
      const { data } = await octokit.rest.checks.listForRef({ owner, repo, ref: p.head.sha, filter: "latest", per_page: 100 });
      return {
        number: p.number,
        title: p.title,
        html_url: p.html_url,
        draft: p.draft === true,
        checks: data.check_runs.map((c) => ({ conclusion: c.conclusion })),
      };
    }),
  );

  // Sorted by updated desc: stop paging once a whole page is older than the window.
  const closed: Awaited<ReturnType<typeof octokit.rest.pulls.list>>["data"] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const { data } = await octokit.rest.pulls.list({
      owner, repo, state: "closed", sort: "updated", direction: "desc", per_page: 100, page,
    });
    closed.push(...data);
    const oldest = data[data.length - 1];
    if (data.length < 100 || (oldest && Date.parse(oldest.updated_at) < since)) break;
  }
  const mergedPrs = closed
    .filter((p) => p.merged_at && Date.parse(p.merged_at) >= since)
    .map((p) => ({ number: p.number, title: p.title, merged_at: p.merged_at, html_url: p.html_url }));

  return { slug, mergedPrs, openPrs, openIssues };
}

/** Thin network layer: one failing repo is reported, never hides the others. */
export async function fetchRepoStatus(
  repos: readonly string[] = DISPATCH_REPO_ALLOWLIST,
): Promise<RepoStatusView> {
  const token = process.env["GITHUB_TOKEN"];
  if (!token) return { summaries: [], unreachable: repos.map((repo) => ({ repo, error: "GITHUB_TOKEN is not set" })) };
  const octokit = new Octokit({ auth: token });
  const summaries: RepoSummary[] = [];
  const unreachable: { repo: string; error: string }[] = [];
  await Promise.all(
    repos.map(async (slug) => {
      try {
        summaries.push(summarizeRepo(await fetchOne(octokit, slug)));
      } catch (err) {
        unreachable.push({ repo: slug, error: err instanceof Error ? err.message : String(err) });
      }
    }),
  );
  summaries.sort((a, b) => repos.indexOf(a.slug) - repos.indexOf(b.slug));
  return { summaries, unreachable };
}
