/**
 * FounderOS — where an Antigravity task actually is
 * =================================================
 * "Where are we on #762?" was the founder's most repeated question between
 * 2026-09-15 and 09-28, about a dozen times. The bot answered from github_read
 * list_issues — every open issue, labels only — and filled the gaps by guessing:
 * "Antigravity is actively executing in its isolated workspace" about a run that
 * had ended with 0 commits, and "I'll monitor it and keep you posted" with
 * nothing monitoring anything.
 *
 * Every fact this needs is already recorded somewhere, by the two VPS daemons:
 *   - issue labels        agent:ready → working → review | failed | blocked
 *   - issue comments      the dispatcher's claim marker, its PR link marker,
 *                         and its own failure report (exit, commits, agy tail)
 *   - the PR              state, draft flag (pr-brain's verdict: ready = cleared),
 *                         check runs, and pr-brain's per-head review markers
 *   - the quota file      ~/.claude/agent-dispatch.quota-until (deploy/agent-dispatch)
 *
 * describeTaskStatus is pure (facts and "now" passed in); fetchTaskFacts reads
 * GitHub and the quota file. No model call, no write.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Octokit } from "octokit";

export interface TaskComment {
  readonly body: string;
  readonly createdAt: string;
}

export interface TaskPr {
  readonly number: number;
  readonly url: string;
  readonly state: "open" | "closed";
  readonly merged: boolean;
  readonly draft: boolean;
  readonly headSha: string;
  readonly baseRef: string;
  readonly checks: { readonly passed: number; readonly failed: number; readonly pending: number };
  /** SHAs pr-brain stamped with `<!-- brain-reviewed: SHA -->`, oldest first. */
  readonly reviewedHeads: readonly string[];
  /** agent-dispatch's review→fix rounds so far (`<!-- agent-attempt: N -->`). */
  readonly attempts: number;
}

export interface TaskFacts {
  readonly repo: string;
  readonly issue: {
    readonly number: number;
    readonly title: string;
    readonly state: "open" | "closed";
    readonly labels: readonly string[];
    readonly createdAt: string;
    readonly url: string;
  };
  readonly comments: readonly TaskComment[];
  readonly pr: TaskPr | null;
  readonly quotaUntil: Date | null;
}

const CLAIM = /<!-- agent-claimed: (\S+)/;
const DISPATCH_FAILURE = /^agent-dispatch could not verify a PR landed[^\n]*/m;
const MAX_ATTEMPTS = 3;

const utc = (d: Date): string => `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
const hhmm = (d: Date): string => `${d.toISOString().slice(11, 16)} UTC`;
const minutesSince = (iso: string, now: Date): number => Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / 60_000));

/** The dispatcher's cron is `*\/15`: the next quarter hour after `now`. */
function nextDispatcherRun(now: Date): Date {
  const next = new Date(now);
  next.setUTCSeconds(0, 0);
  next.setUTCMinutes(Math.floor(now.getUTCMinutes() / 15) * 15 + 15);
  return next;
}

function checksLine(c: TaskPr["checks"]): string {
  const total = c.passed + c.failed + c.pending;
  if (total === 0) return "CI: no checks reported yet";
  if (c.failed > 0) return `CI: ${c.failed} failing, ${c.passed} passed, ${c.pending} running`;
  if (c.pending > 0) return `CI: ${c.passed}/${total} passed, ${c.pending} still running`;
  return `CI: ${c.passed}/${total} passed`;
}

function prLines(pr: TaskPr): string[] {
  const lines = [`PR #${pr.number} → ${pr.baseRef} · ${checksLine(pr.checks)}`];
  if (!pr.reviewedHeads.includes(pr.headSha)) {
    lines.push("Claude's review: waiting for Claude's review of the latest commit (pr-brain runs every 20 min).");
  } else if (pr.draft) {
    lines.push(
      `Claude reviewed the current head and left it as a draft (not cleared). Antigravity is sent back to fix it ` +
        `automatically — round ${pr.attempts}/${MAX_ATTEMPTS}.`,
    );
  } else {
    lines.push("Claude reviewed the current head and cleared it (ready to merge).");
  }
  lines.push(pr.url);
  return lines;
}

/** One answer to "where are we on #N": the stage first, then the evidence. */
export function describeTaskStatus(f: TaskFacts, now: Date): string {
  const { issue, pr } = f;
  const labels = new Set(issue.labels);
  const head = `#${issue.number} ${issue.title} (${f.repo})`;
  const notices =
    "You get a Telegram message from agent-dispatch when a PR opens or a run fails, and from pr-brain when a review finishes.";

  if (pr?.merged) {
    return [head, `✅ Done — PR #${pr.number} merged into ${pr.baseRef}.`, pr.url].join("\n");
  }
  if (issue.state === "closed") {
    const last = f.comments.at(-1)?.body.split("\n")[0] ?? "no closing comment";
    return [head, `Closed without a merged PR. Last note: ${last}`, issue.url].join("\n");
  }
  if (labels.has("agent:blocked")) {
    return [
      head,
      `🛑 Stopped after ${MAX_ATTEMPTS} review→fix rounds — it needs your decision. Nothing more happens automatically.`,
      ...(pr ? prLines(pr) : [issue.url]),
    ].join("\n");
  }
  if (labels.has("agent:failed")) {
    const report = [...f.comments].reverse().find((c) => DISPATCH_FAILURE.test(c.body));
    const reason = report?.body.match(DISPATCH_FAILURE)?.[0] ?? "no failure report on the issue";
    return [
      head,
      `❌ Antigravity's run failed: ${reason}`,
      "It will not be retried on its own. Say “re-queue #" + issue.number + "” and I'll put the SAME issue back in the queue (one tap).",
      issue.url,
    ].join("\n");
  }
  if (labels.has("agent:review") && pr) {
    return [head, "👀 In review.", ...prLines(pr), notices].join("\n");
  }
  if (labels.has("agent:working")) {
    const claim = [...f.comments].reverse().map((c) => c.body.match(CLAIM)?.[1]).find(Boolean);
    const since = claim ? `claimed ${minutesSince(claim, now)} min ago` : "claimed";
    return [head, `🔧 Antigravity is working on it — ${since}. A run is cut off at 30 min.`, notices, issue.url].join("\n");
  }
  if (labels.has("agent:ready")) {
    const waiting = f.quotaUntil && f.quotaUntil > now
      ? `⏸️ Queued, but Antigravity's quota is exhausted until ${utc(f.quotaUntil)}. It starts automatically then — nothing is retried before.`
      : `🕒 Queued — nothing has started yet. agent-dispatch picks it up at its next run, ${hhmm(nextDispatcherRun(now))}.`;
    return [head, waiting, notices, issue.url].join("\n");
  }
  return [head, "Not an Antigravity task — it has no agent:* label.", issue.url].join("\n");
}

// ── Reading the facts ─────────────────────────────────────────────────────────

const QUOTA_FILE = join(homedir(), ".claude", "agent-dispatch.quota-until");

export async function readQuotaUntil(file: string = QUOTA_FILE): Promise<Date | null> {
  try {
    const epoch = Number((await readFile(file, "utf8")).trim());
    return Number.isFinite(epoch) && epoch > 0 ? new Date(epoch * 1000) : null;
  } catch {
    // allow-failopen: no file is the normal case — the quota is not exhausted.
    return null;
  }
}

export async function fetchTaskFacts(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  quotaReader: () => Promise<Date | null> = () => readQuotaUntil(),
): Promise<TaskFacts> {
  const { data: issue } = await octokit.rest.issues.get({ owner, repo, issue_number: issueNumber });
  const { data: rawComments } = await octokit.rest.issues.listComments({ owner, repo, issue_number: issueNumber, per_page: 100 });
  const comments = rawComments.map((c) => ({ body: c.body ?? "", createdAt: c.created_at }));

  const linked = [...comments].reverse().map((c) => c.body.match(/<!-- agent-pr: (\d+)/)?.[1]).find(Boolean);
  let prNumber = linked ? Number(linked) : undefined;
  if (prNumber === undefined) {
    const { data: prs } = await octokit.rest.pulls.list({ owner, repo, state: "all", per_page: 100 });
    prNumber = prs.find((p) => p.head.ref.startsWith(`task/issue-${issueNumber}-`))?.number;
  }

  let pr: TaskPr | null = null;
  if (prNumber !== undefined) {
    const { data: p } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
    const { data: prComments } = await octokit.rest.issues.listComments({ owner, repo, issue_number: prNumber, per_page: 100 });
    const { data: checkRuns } = await octokit.rest.checks.listForRef({ owner, repo, ref: p.head.sha, per_page: 100 });
    const runs = checkRuns.check_runs;
    const bodies = prComments.map((c) => c.body ?? "");
    pr = {
      number: p.number,
      url: p.html_url,
      state: p.state === "open" ? "open" : "closed",
      merged: Boolean(p.merged),
      draft: Boolean(p.draft),
      headSha: p.head.sha,
      baseRef: p.base.ref,
      checks: {
        passed: runs.filter((r) => r.status === "completed" && ["success", "skipped", "neutral"].includes(r.conclusion ?? "")).length,
        failed: runs.filter((r) => r.status === "completed" && !["success", "skipped", "neutral"].includes(r.conclusion ?? "")).length,
        pending: runs.filter((r) => r.status !== "completed").length,
      },
      reviewedHeads: bodies.flatMap((b) => [...b.matchAll(/brain-reviewed: ([0-9a-f]{7,40})/g)].map((m) => m[1]!)),
      attempts: Math.max(0, ...bodies.map((b) => Number(b.match(/<!-- agent-attempt: (\d+)/)?.[1] ?? 0))),
    };
  }

  return {
    repo: `${owner}/${repo}`,
    issue: {
      number: issue.number,
      title: issue.title,
      state: issue.state === "open" ? "open" : "closed",
      labels: issue.labels.map((l) => (typeof l === "string" ? l : (l.name ?? ""))),
      createdAt: issue.created_at,
      url: issue.html_url,
    },
    comments,
    pr,
    quotaUntil: await quotaReader(),
  };
}
