/**
 * FounderOS — /tasks: "Ready for you to merge"
 * ============================================
 * Which open PRs a founder can merge right now: non-draft, stamped
 * `brain-reviewed:` for the current head, green CI, and no conflict with the
 * base. A row here is a claim that one click merges it, so every input that
 * could not be confirmed (no CI, mergeability not computed, comments
 * unreadable) keeps the PR OFF the list — and the unreadable cases are
 * reported with the reason rather than dropped.
 */

import type { Octokit } from "octokit";

export interface ReadyMergePr {
  readonly repo: string;
  readonly prNumber: number;
  readonly title: string;
  readonly url: string;
  /** The head the review and CI were read for. A merge button pins to it. Absent on rows built by hand. */
  readonly headSha?: string;
  /** The branch it merges into. */
  readonly base?: string;
}

export interface Unreachable {
  repo: string;
  error: string;
}

/** Checks if a list of comment bodies contains a pr-brain reviewed marker matching the head SHA. */
export function isPrBrainReviewed(comments: readonly string[], headSha: string): boolean {
  if (!headSha) return false;
  return comments.some((body) => {
    if (!body.includes("brain-reviewed:")) return false;
    const matches = body.matchAll(/brain-reviewed:\s*([0-9a-f]{7,40})/gi);
    for (const match of matches) {
      const sha = match[1];
      if (sha && (headSha.toLowerCase().startsWith(sha.toLowerCase()) || sha.toLowerCase().startsWith(headSha.toLowerCase()))) {
        return true;
      }
    }
    return false;
  });
}

/**
 * Checks if the head commit SHA has passing/green CI checks.
 *
 * A head with no check runs AND no statuses is NOT green: nothing ran, so
 * nothing passed. House-of-Hulda-Website-frontend #7 (zero checks, conflicting)
 * was listed as ready because "no failures" was read as "passed".
 */
export async function isGreenCI(
  octokit: Octokit,
  owner: string,
  repo: string,
  headSha: string,
): Promise<boolean> {
  try {
    const { data: checkRunsData } = await octokit.rest.checks.listForRef({
      owner,
      repo,
      ref: headSha,
      per_page: 100,
    });
    const runs = checkRunsData.check_runs ?? [];
    if (runs.length > 0) {
      const allCompletedAndPassed = runs.every(
        (r) =>
          r.status === "completed" &&
          ["success", "skipped", "neutral"].includes(r.conclusion ?? ""),
      );
      if (!allCompletedAndPassed) return false;
    }

    const { data: combined } = await octokit.rest.repos.getCombinedStatusForRef({
      owner,
      repo,
      ref: headSha,
    });
    const statuses = combined.statuses ?? [];
    if (statuses.length > 0) {
      if (combined.state !== "success") return false;
    }

    return runs.length > 0 || statuses.length > 0;
  } catch {
    // allow-failopen: a failure reading CI status defaults to not green (fail-closed for safety).
    return false;
  }
}

const NOT_MERGEABLE_YET: Readonly<Record<string, string>> = {
  behind: "it is behind its base and must be updated first (Update branch on GitHub)",
  blocked: "branch protection blocks the merge (a required check or review is missing for its current head)",
};

/**
 * Ready PRs for one repository, plus every PR that could not be judged.
 *
 * Pages through all open PRs and all comments: the review marker is usually
 * the newest comment, which is exactly the one a single page drops on a long
 * thread. A failure to list PRs throws, so the caller marks the whole repo
 * unreachable; a failure on one PR is recorded against that PR only.
 */
export async function collectReadyToMerge(
  octokit: Octokit,
  owner: string,
  repo: string,
  slug: string,
): Promise<{ ready: ReadyMergePr[]; unreachable: Unreachable[] }> {
  const ready: ReadyMergePr[] = [];
  const unreachable: Unreachable[] = [];
  const prs = await octokit.paginate(octokit.rest.pulls.list, { owner, repo, state: "open", per_page: 100 });

  for (const pr of prs) {
    if (pr.draft) continue;
    try {
      const rawComments = await octokit.paginate(octokit.rest.issues.listComments, {
        owner,
        repo,
        issue_number: pr.number,
        per_page: 100,
      });
      if (!isPrBrainReviewed(rawComments.map((c) => c.body ?? ""), pr.head.sha)) continue;
      if (!(await isGreenCI(octokit, owner, repo, pr.head.sha))) continue;

      // pulls.list never carries mergeability; only pulls.get computes it.
      const { data: full } = await octokit.rest.pulls.get({ owner, repo, pull_number: pr.number });
      if (full.mergeable === null) {
        unreachable.push({
          repo: slug,
          error: `PR #${pr.number} is reviewed and green, but GitHub has not finished computing whether it is mergeable — run /tasks again in a minute`,
        });
        continue;
      }
      if (!full.mergeable || full.mergeable_state === "dirty") continue; // conflicts with its base
      // Reviewed and green, but the merge button would still refuse: say why instead of listing it as one click.
      const notYet = NOT_MERGEABLE_YET[full.mergeable_state ?? ""];
      if (notYet) {
        unreachable.push({ repo: slug, error: `PR #${pr.number} is reviewed and green, but ${notYet}` });
        continue;
      }

      ready.push({
        repo: slug,
        prNumber: pr.number,
        title: pr.title,
        url: pr.html_url,
        headSha: pr.head.sha,
        base: pr.base.ref,
      });
    } catch (err) {
      unreachable.push({
        repo: slug,
        error: `PR #${pr.number} could not be checked — ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  return { ready, unreachable };
}
