/**
 * FounderOS — /tasks
 * ==================
 * What the engineering loop is doing right now, in one message.
 */

import type { Context } from "grammy";
import { Octokit } from "octokit";
import { esc } from "../tools/jobhunt/telegram-format.js";
import { DISPATCH_REPO_ALLOWLIST } from "../tools/dispatch-repos.js";
import { REVIEWER } from "../tools/dispatch-roles.js";
import { splitForTelegram } from "./format.js";

/** The agent lifecycle labels, in the order work moves through them. */
export const AGENT_STATES = ["ready", "working", "review", "blocked", "failed"] as const;
export type AgentState = (typeof AGENT_STATES)[number];

const STATE_ICON: Record<AgentState, string> = {
  ready: "🕒",
  working: "🛠",
  review: "🔎",
  blocked: "🛑",
  failed: "⚠️",
};

const STATE_MEANING: Record<AgentState, string> = {
  ready: "queued — Antigravity starts within a minute of filing (the 15-minute tick is the backstop)",
  working: "Antigravity is writing the code now",
  review: `PR open — ${REVIEWER} is reviewing it; anything it finds goes back to Antigravity`,
  blocked: "hit the attempt limit — this one needs you",
  failed: "the run itself broke before producing a PR",
};

export interface TaskRow {
  readonly repo: string;
  readonly issue: number;
  readonly title: string;
  readonly state: AgentState;
  readonly url: string;
  /** Minutes since the issue last changed. Used to surface a stuck claim. */
  readonly ageMinutes: number;
}

export interface ReadyMergePr {
  readonly repo: string;
  readonly prNumber: number;
  readonly title: string;
  readonly url: string;
}

export interface TasksView {
  readonly rows: readonly TaskRow[];
  readonly readyToMerge?: readonly ReadyMergePr[];
  /** Repositories that could not be read, with the reason. Never hidden. */
  readonly unreachable: readonly { repo: string; error: string }[];
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
    if (combined.statuses && combined.statuses.length > 0) {
      if (combined.state !== "success") return false;
    }

    return true;
  } catch {
    // allow-failopen: a failure reading CI status defaults to not green (fail-closed for safety).
    return false;
  }
}

/** First agent:* label on the issue, or null when it carries none. */
export function stateFromLabels(labels: readonly string[]): AgentState | null {
  for (const state of AGENT_STATES) {
    if (labels.some((l) => l.toLowerCase() === `agent:${state}`)) return state;
  }
  return null;
}

/** "3m" · "2h 10m" · "4d". Short enough to sit at the end of a title line. */
export function formatAge(minutes: number): string {
  if (minutes < 60) return `${Math.max(0, Math.round(minutes))}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = Math.round(minutes % 60);
    return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`;
  }
  return `${Math.floor(hours / 24)}d`;
}

/** Short repo name — the owner is noise when every row shares four of them. */
function shortRepo(slug: string): string {
  return slug.split("/")[1] ?? slug;
}

/**
 * Rows rendered before the message is trimmed.
 *
 * Telegram hard-fails a message over TELEGRAM_MAX_CHARS, so an unbounded queue
 * does not render badly — it throws, and `/tasks` answers nothing at exactly the
 * moment the queue is most interesting. Measured: 40 rows produced 5,638 of a
 * 4,096 budget.
 */
export const MAX_RENDERED_ROWS = 18;

/**
 * Which rows survive the cap: the ones a founder can act on.
 *
 * NOT collection order, and not the lifecycle order the sections are printed in.
 * A truncated list sorted by arrival reports the least interesting rows by
 * construction — `agent:ready` is the state that needs nothing from anybody, and
 * it is also the state that would fill the message first.
 */
const ACTIONABILITY: readonly AgentState[] = ["blocked", "failed", "review", "working", "ready"];

export function selectRenderedRows(rows: readonly TaskRow[]): {
  shown: TaskRow[];
  hidden: TaskRow[];
} {
  if (rows.length <= MAX_RENDERED_ROWS) return { shown: [...rows], hidden: [] };

  const ranked = [...rows].sort((a, b) => {
    const byState = ACTIONABILITY.indexOf(a.state) - ACTIONABILITY.indexOf(b.state);
    return byState !== 0 ? byState : a.ageMinutes - b.ageMinutes;
  });
  return { shown: ranked.slice(0, MAX_RENDERED_ROWS), hidden: ranked.slice(MAX_RENDERED_ROWS) };
}

/**
 * PURE. The whole message.
 *
 * An empty queue prints as an empty queue and says what to type next, rather than
 * as nothing at all: "no output" is the single most common way a founder learns
 * to stop trusting a command. Unreachable repositories are printed too — a repo
 * whose token expired would otherwise look exactly like a repo with no work in
 * it, which is the ambiguity that let the dead review arrow hide for days.
 */
export function formatTasksMessage(view: TasksView): string {
  const lines: string[] = ["🤖 <b>Engineering loop</b>"];
  const ready = view.readyToMerge ?? [];

  // The shape before the list. Measured on the first live run: 15 open issues,
  // 11 of them agent:failed and the oldest 39 days — a wall of rows in which the
  // one thing that needed a human was indistinguishable from a graveyard. A
  // count line is read in a second; fifteen rows are not read at all.
  if (view.rows.length > 0 || ready.length > 0) {
    const summaryParts: string[] = [];
    if (ready.length > 0) {
      summaryParts.push(`🔀 ${ready.length} ready to merge`);
    }
    const counts = AGENT_STATES.map((state) => ({
      state,
      n: view.rows.filter((r) => r.state === state).length,
    })).filter((c) => c.n > 0);
    for (const c of counts) {
      summaryParts.push(`${STATE_ICON[c.state]} ${c.n} ${c.state}`);
    }
    if (summaryParts.length > 0) {
      lines.push(summaryParts.join("  ·  "));
    }
  }

  if (ready.length > 0) {
    lines.push("", "🔀 <b>Ready for you to merge</b>");
    for (const pr of ready) {
      lines.push(
        `<a href="${pr.url}">#${pr.prNumber}</a> <b>${esc(shortRepo(pr.repo))}</b> · ${esc(pr.title)}`,
      );
    }
  }

  if (view.rows.length === 0 && ready.length === 0) {
    lines.push(
      "",
      "Nothing in flight. Every dispatched task is finished or closed.",
      "",
      "Start one: <code>/task repo:app fix the flaky CSV export</code>",
    );
  } else if (view.rows.length > 0) {
    const { shown, hidden } = selectRenderedRows(view.rows);
    for (const state of AGENT_STATES) {
      const inState = shown.filter((r) => r.state === state);
      if (inState.length === 0) continue;
      lines.push("", `${STATE_ICON[state]} <b>${state}</b> — <i>${STATE_MEANING[state]}</i>`);
      for (const row of inState) {
        lines.push(
          `<a href="${row.url}">#${row.issue}</a> <b>${esc(shortRepo(row.repo))}</b> · ${formatAge(row.ageMinutes)}`,
          `<i>${esc(row.title)}</i>`,
        );
      }
    }
    if (hidden.length > 0) {
      // Says WHICH states were dropped, not just how many. "12 more" is a number;
      // "12 more, all queued" is the difference between fine and a stuck queue.
      const states = [...new Set(hidden.map((r) => r.state))].join(", ");
      lines.push("", `<i>+${hidden.length} more not shown (${states}) — the full queue is on GitHub.</i>`);
    }
  }

  for (const miss of view.unreachable) {
    lines.push("", `⚠️ <b>${esc(shortRepo(miss.repo))}</b> could not be read — ${esc(miss.error)}`);
  }

  lines.push(
    "",
    "<i>Verdicts arrive here on their own. " +
      "🛑 blocked is the only state waiting on you.</i>",
  );
  return lines.join("\n");
}

/**
 * Read every dispatchable repository's open agent issues and ready-to-merge PRs.
 *
 * Partial by design: a repository that throws is recorded in `unreachable` and
 * the rest still render. Failing the whole command on one bad repo would make
 * `/tasks` least available exactly when something is wrong, which is when it is
 * needed most.
 */
export async function fetchDispatchTasks(
  repos: readonly string[] = DISPATCH_REPO_ALLOWLIST,
  now: () => number = Date.now,
): Promise<TasksView> {
  const token = process.env["GITHUB_TOKEN"];
  if (!token) {
    return { rows: [], readyToMerge: [], unreachable: repos.map((repo) => ({ repo, error: "GITHUB_TOKEN is not set" })) };
  }

  const octokit = new Octokit({ auth: token });
  const rows: TaskRow[] = [];
  const readyToMerge: ReadyMergePr[] = [];
  const unreachable: { repo: string; error: string }[] = [];

  await Promise.all(
    repos.map(async (slug) => {
      const [owner, repo] = slug.split("/");
      if (!owner || !repo) {
        unreachable.push({ repo: slug, error: "not a valid owner/repo slug" });
        return;
      }
      try {
        const { data: issues } = await octokit.rest.issues.listForRepo({
          owner,
          repo,
          state: "open",
          per_page: 50,
        });
        for (const issue of issues) {
          if (issue.pull_request) continue; // a PR is not a task; it is a task's output
          const labels = issue.labels.map((l) => (typeof l === "string" ? l : (l.name ?? "")));
          const state = stateFromLabels(labels);
          if (!state) continue;
          rows.push({
            repo: slug,
            issue: issue.number,
            title: issue.title,
            state,
            url: issue.html_url,
            ageMinutes: (now() - new Date(issue.updated_at).getTime()) / 60_000,
          });
        }

        const { data: prs } = await octokit.rest.pulls.list({
          owner,
          repo,
          state: "open",
          per_page: 50,
        });

        for (const pr of prs) {
          if (pr.draft) continue;

          let comments: string[] = [];
          try {
            const { data: rawComments } = await octokit.rest.issues.listComments({
              owner,
              repo,
              issue_number: pr.number,
              per_page: 100,
            });
            comments = rawComments.map((c) => c.body ?? "");
          } catch {
            // allow-failopen: if listing comments fails for a PR, skip it.
          }

          if (!isPrBrainReviewed(comments, pr.head.sha)) continue;

          const green = await isGreenCI(octokit, owner, repo, pr.head.sha);
          if (!green) continue;

          readyToMerge.push({
            repo: slug,
            prNumber: pr.number,
            title: pr.title,
            url: pr.html_url,
          });
        }
      } catch (err) {
        unreachable.push({ repo: slug, error: err instanceof Error ? err.message : String(err) });
      }
    }),
  );

  rows.sort((a, b) => a.ageMinutes - b.ageMinutes);
  readyToMerge.sort((a, b) => a.repo.localeCompare(b.repo) || a.prNumber - b.prNumber);
  return { rows, readyToMerge, unreachable };
}

export interface TasksCommandDeps {
  readonly fetch: (repos: readonly string[]) => Promise<TasksView>;
  readonly listRegisteredRepos?: () => Promise<readonly string[]>;
}

/**
 * `/tasks` handler.
 *
 * A thrown GitHub client (bad token shape, network down at construction) still
 * has to produce a message. A status command that answers with nothing teaches
 * the founder that the loop is dead when in fact only the view is.
 */
export async function handleTasks(
  ctx: Context,
  deps: TasksCommandDeps = { fetch: (repos) => fetchDispatchTasks(repos) },
): Promise<void> {
  let allRepos: readonly string[] = DISPATCH_REPO_ALLOWLIST;
  try {
    const registered = (await deps.listRegisteredRepos?.()) ?? [];
    allRepos = [...new Set([...DISPATCH_REPO_ALLOWLIST, ...registered])];
  } catch {
    // allow-failopen: a registry that cannot be read must not take /tasks down for the hardcoded repos.
  }
  let view: TasksView;
  try {
    view = await deps.fetch(allRepos);
  } catch (err) {
    view = {
      rows: [],
      unreachable: [{ repo: "all repositories", error: err instanceof Error ? err.message : String(err) }],
    };
  }
  const parts = splitForTelegram(formatTasksMessage(view));
  for (const part of parts) {
    await ctx.reply(part, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  }
}
