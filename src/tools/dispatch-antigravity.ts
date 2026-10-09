/**
 * FounderOS — file one coding job as a GitHub issue (AG-062).
 * ===========================================================
 * FounderOS decides WHICH work and carries the founder's words; the coding tool decides HOW. So the issue is his
 * message, verbatim, under the model's title, with the labels the job reads (agent:ready, antigravity, the engine).
 * His words also go on the issue as one hidden comment line (./founder-words.ts), which deploy/agent-dispatch reads
 * into the prompt. There is no brief template and no lint: on 2026-10-09 a FounderOS-shaped brief (vitest under
 * tests/unit, pnpm verify:arch) made every Oplify PR fail review.
 *
 * TARGET REPO IS PINNED TO AN ALLOWLIST (./dispatch-repos.ts). `repo` is a caller-supplied argument that takes
 * precedence over ISSUE_REPO, and the token can write to far more than these repos. `assertDispatchableRepo` is the
 * boundary, and env vars pass through it too.
 */

import { Octokit } from "octokit";
import { childLogger } from "../infra/logger.js";
import { assertDispatchableRepo, DEFAULT_DISPATCH_REPO } from "./dispatch-repos.js";
import { listRegisteredDispatchRepos } from "../db/queries.js";
import { TENANT } from "../core/config.js";
import { startDispatchJob, startFailureNote } from "./dispatch-tick.js";
import { engineLabel, type Engine } from "./coding-engine.js";
import { founderWordsMarker } from "./founder-words.js";
import { checkRepoReach } from "./repo-reach.js";

const log = childLogger({ module: "tool:dispatch-antigravity" });

/** Re-exported so existing importers keep one import site for the dispatch defaults. */
export { DEFAULT_DISPATCH_REPO };
export const AGENT_READY_LABEL = "agent:ready";
export const ANTIGRAVITY_LABEL = "antigravity";

function getOctokit(): Octokit {
  const token = process.env["GITHUB_TOKEN"];
  if (!token) throw new Error("GITHUB_TOKEN not configured — set it in .env");
  return new Octokit({ auth: token });
}

export async function resolveDispatchRepo(repoArg?: string): Promise<{ owner: string; repo: string }> {
  const slug = repoArg?.trim() ||
    process.env["ISSUE_REPO"] ||
    process.env["SELF_IMPROVE_ISSUE_REPO"] ||
    DEFAULT_DISPATCH_REPO;

  // Async because the set of permitted repos is the hardcoded list PLUS the project
  // repos this instance created (see create-project-repo.ts) — a repo made last week
  // cannot be in a list compiled last month. A registry read failure degrades to the
  // hardcoded list rather than throwing, so the two provisioned repos keep working.
  //
  // Env vars go through the same gate as the model's argument. A misconfigured VPS
  // should fail loudly here, not quietly file issues into a repo nobody is watching.
  return assertDispatchableRepo(slug, await listRegisteredDispatchRepos(TENANT));
}

export interface FiledJob {
  readonly issueNumber: number;
  readonly issueUrl: string;
  readonly repo: string;
  readonly labels: readonly string[];
  /** Set when the issue was filed but its run could not start. */
  readonly warning?: string;
}

/** Files the issue, posts the words marker and starts its build run. Called only after the founder approved the card. */
export async function fileDispatchIssue(args: {
  owner: string;
  repo: string;
  title: string;
  words: string;
  engine: Engine;
}): Promise<{ ok: true; job: FiledJob } | { ok: false; error: string }> {
  const { owner, repo, title, words, engine } = args;
  let octokit: Octokit;
  try {
    octokit = getOctokit();
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  const reach = await checkRepoReach({ owner, repo }, octokit); // AG-039: refused in words before issues.create
  if (!reach.ok) return { ok: false, error: reach.message };

  // Exactly one engine label: an issue carrying both is ambiguous to the daemon, which then falls back to the default.
  const labels = [AGENT_READY_LABEL, ANTIGRAVITY_LABEL, engineLabel(engine)];
  const slug = `${owner}/${repo}`;
  try {
    const { data } = await octokit.rest.issues.create({ owner, repo, title: title.trim(), body: words.trim(), labels });
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: data.number,
      body: `Filed from Telegram with the founder's words above. agent-dispatch reads them from this line.\n\n${founderWordsMarker(words)}`,
    });
    log.info({ owner, repo, issue_number: data.number, url: data.html_url }, "Filed coding job issue");
    // The run starts now, in its own process, and reports its own outcome. When it cannot start, the founder hears
    // it in this reply: the issue is filed, but nothing is working on it.
    const started = await startDispatchJob(data.number, slug, "build");
    const warning = started.status === "failed" ? startFailureNote(data.number, slug, started.reason) : undefined;
    return { ok: true, job: { issueNumber: data.number, issueUrl: data.html_url, repo: slug, labels, ...(warning ? { warning } : {}) } };
  } catch (err) {
    const message = (err as Error).message;
    log.error({ owner, repo, err: message }, "Failed to create dispatch issue");
    return { ok: false, error: `GitHub issue creation failed: ${message}` };
  }
}
