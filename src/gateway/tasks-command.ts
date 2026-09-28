/**
 * FounderOS — /tasks
 * ==================
 * What the engineering loop is doing right now, in one message.
 *
 * WHY IT EXISTS. `/task` starts work that takes twenty to forty minutes and
 * happens on a machine the founder cannot see. Between the approval card and
 * pr-brain's verdict there was NOTHING to ask — no command, no view, no way to
 * tell "Antigravity is building it" from "the claim was released an hour ago and
 * nobody noticed". The only honest answer to "where is my task?" was: open
 * GitHub on four repositories and read the labels yourself.
 *
 * That gap has a measured cost. Issue #710 sat at `agent:review` with a
 * brain-reviewed draft PR and zero attempts while every dispatch tick skipped it
 * — the review→fix arrow was dead for days and the only symptom was silence.
 * A loop whose state is invisible cannot be noticed to have stopped.
 *
 * THE LABELS ARE THE STATE MACHINE. agent-dispatch owns them, this only reads:
 *
 *   agent:ready   → filed, waiting for the next dispatch tick (≤15 min)
 *   agent:working → Antigravity is implementing it right now
 *   agent:review  → a PR exists; pr-brain gates it and re-dispatches findings
 *   agent:blocked → hit the attempt bound; needs a human
 *   agent:failed  → the run itself broke (workspace, no PR produced)
 *
 * Rendering is a PURE function over rows so the message is fixture-tested, and
 * the I/O half returns partial results rather than failing: one unreachable
 * repository must not blank the whole view.
 */

import type { Context } from "grammy";
import { Octokit } from "octokit";
import { esc } from "../tools/jobhunt/telegram-format.js";
import { DISPATCH_REPO_ALLOWLIST } from "../tools/dispatch-repos.js";
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
  ready: "queued — a dispatch tick picks this up within 15 minutes",
  working: "Antigravity is writing the code now",
  review: "PR open — Claude is gating it and re-dispatching anything it finds",
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

export interface TasksView {
  readonly rows: readonly TaskRow[];
  /** Repositories that could not be read, with the reason. Never hidden. */
  readonly unreachable: readonly { repo: string; error: string }[];
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

  // The shape before the list. Measured on the first live run: 15 open issues,
  // 11 of them agent:failed and the oldest 39 days — a wall of rows in which the
  // one thing that needed a human was indistinguishable from a graveyard. A
  // count line is read in a second; fifteen rows are not read at all.
  if (view.rows.length > 0) {
    const counts = AGENT_STATES.map((state) => ({
      state,
      n: view.rows.filter((r) => r.state === state).length,
    })).filter((c) => c.n > 0);
    lines.push(counts.map((c) => `${STATE_ICON[c.state]} ${c.n} ${c.state}`).join("  ·  "));
  }

  if (view.rows.length === 0) {
    lines.push(
      "",
      "Nothing in flight. Every dispatched task is finished or closed.",
      "",
      "Start one: <code>/task repo:app fix the flaky CSV export</code>",
    );
  } else {
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
 * Read every dispatchable repository's open agent issues.
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
    return { rows: [], unreachable: repos.map((repo) => ({ repo, error: "GITHUB_TOKEN is not set" })) };
  }

  const octokit = new Octokit({ auth: token });
  const rows: TaskRow[] = [];
  const unreachable: { repo: string; error: string }[] = [];

  await Promise.all(
    repos.map(async (slug) => {
      const [owner, repo] = slug.split("/");
      if (!owner || !repo) {
        unreachable.push({ repo: slug, error: "not a valid owner/repo slug" });
        return;
      }
      try {
        const { data } = await octokit.rest.issues.listForRepo({
          owner,
          repo,
          state: "open",
          per_page: 50,
        });
        for (const issue of data) {
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
      } catch (err) {
        unreachable.push({ repo: slug, error: err instanceof Error ? err.message : String(err) });
      }
    }),
  );

  rows.sort((a, b) => a.ageMinutes - b.ageMinutes);
  return { rows, unreachable };
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
