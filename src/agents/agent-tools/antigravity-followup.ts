/**
 * Engineering tools — follow up on an Antigravity task.
 * ====================================================
 *   antigravity_task_status   read-only: where issue #N is, from what GitHub and
 *                             the dispatcher recorded (src/tools/antigravity-status.ts)
 *   requeue_antigravity_task  HITL-gated: put the SAME issue back in the queue
 *
 * Before these existed the founder asked "where are we on #762?" about a dozen
 * times and got guesses built from list_issues, and "dispatch it again" made the
 * bot try to open a second issue for the same work (rejected, 2026-09-28 18:49).
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { Octokit } from "octokit";
import { describeTaskStatus, fetchTaskFacts, type TaskFacts } from "../../tools/antigravity-status.js";
import { resolveDispatchRepo } from "../../tools/dispatch-antigravity.js";
import { startDispatchJob, startFailureNote } from "../../tools/dispatch-tick.js";
import { hitlGate, idemKey } from "./hitl.js";
import { hasBeenAudited, writeAuditEntry } from "../../db/queries.js";
import { TENANT } from "../../core/config.js";
import { childLogger } from "../../infra/logger.js";

const log = childLogger({ module: "agent-tools:antigravity-followup" });

interface Target {
  readonly gh: Octokit;
  readonly owner: string;
  readonly repo: string;
  readonly slug: string;
}

async function target(repoArg: string | null | undefined): Promise<Target | string> {
  const token = process.env["GITHUB_TOKEN"];
  if (!token) return "❌ Cannot read GitHub: GITHUB_TOKEN is not configured on the server.";
  try {
    const { owner, repo } = await resolveDispatchRepo(repoArg ?? undefined);
    return { gh: new Octokit({ auth: token }), owner, repo, slug: `${owner}/${repo}` };
  } catch (err) {
    return `❌ ${(err as Error).message}`;
  }
}

/** The named issue, or the most recently filed Antigravity issue in the repo. */
async function resolveIssue(t: Target, issue: number | null | undefined): Promise<number | undefined> {
  if (issue) return issue;
  const { data } = await t.gh.rest.issues.listForRepo({
    owner: t.owner, repo: t.repo, labels: "antigravity", state: "all", sort: "created", direction: "desc", per_page: 1,
  });
  return data[0]?.number;
}

const schema = z.object({
  issue: z
    .number()
    .int()
    .min(1)
    .optional()
    .nullable()
    .describe("GitHub issue number, e.g. 762. Omit for the most recently dispatched Antigravity task."),
  repo: z.string().optional().nullable().describe("owner/name. Defaults to pushkarverma3698/FounderOS."),
});

export const antigravityTaskStatus = tool(
  async ({ issue, repo }) => {
    const t = await target(repo);
    if (typeof t === "string") return t;
    try {
      const n = await resolveIssue(t, issue);
      if (n === undefined) return `No Antigravity issue found on ${t.slug}.`;
      return describeTaskStatus(await fetchTaskFacts(t.gh, t.owner, t.repo, n), new Date());
    } catch (err) {
      return `❌ Could not read the task on ${t.slug}: ${(err as Error).message}`;
    }
  },
  {
    name: "antigravity_task_status",
    description:
      "Where an Antigravity task stands — queued, working, failed (with the dispatcher's own reason), in review " +
      "(PR, CI, Claude's verdict), blocked or merged — read from GitHub and the dispatcher. Read-only, no approval. " +
      "ALWAYS use this for 'where are we on #N', 'is it done', 'did Antigravity pick it up', 'why isn't it picked up'. " +
      "Never answer those from list_issues, and never promise to monitor: this answer names the real notifications.",
    schema,
  },
);

function refusal(facts: TaskFacts): string | null {
  const labels = new Set(facts.issue.labels);
  if (facts.pr?.merged) return "Nothing to re-queue — its PR is merged.";
  if (labels.has("agent:working") || labels.has("agent:review") || facts.pr?.state === "open") {
    return "Not re-queued: it is already in progress, and a second run would race the first.";
  }
  if (labels.has("agent:blocked")) {
    return "Not re-queued: it stopped after 3 review→fix rounds on an open PR. It needs your decision on that PR — a fresh run would start over on top of it.";
  }
  return null;
}

export const requeueAntigravityTask = tool(
  async ({ issue, repo }, config) => {
    const t = await target(repo);
    if (typeof t === "string") return t;
    let facts: TaskFacts;
    let n: number | undefined;
    try {
      n = await resolveIssue(t, issue);
      if (n === undefined) return `No Antigravity issue found on ${t.slug}.`;
      facts = await fetchTaskFacts(t.gh, t.owner, t.repo, n);
    } catch (err) {
      return `❌ Could not read the task on ${t.slug}: ${(err as Error).message}`;
    }
    const status = describeTaskStatus(facts, new Date());

    const refused = refusal(facts);
    if (refused) return `${refused}\n\n${status}`;

    // Already queued: nudging the dispatcher changes nothing on GitHub, so no card.
    if (facts.issue.state === "open" && facts.issue.labels.includes("agent:ready")) {
      const started = await startDispatchJob(n, t.slug, "build");
      const note = started.status === "failed" ? `\n⚠️ ${startFailureNote(n, t.slug, started.reason)}` : "";
      return `#${n} is already queued — I started its run now. Nothing new was filed.${note}\n\n${status}`;
    }

    // State-derived key: once this runs, the labels and comment count change, so a
    // replayed resume takes the "already queued" branch above instead of re-writing.
    const key = idemKey("requeue_antigravity", t.slug, String(n), String(facts.comments.length));
    if (await hasBeenAudited(key)) return `#${n} was already re-queued.\n\n${status}`;

    const rejected = await hitlGate(
      {
        action: "requeue_antigravity_task",
        title: `🔁 Put #${n} back in Antigravity's queue?`,
        summary: `Same issue, nothing new filed: ${t.slug}#${n} "${facts.issue.title}" → agent:ready`,
        preview: status,
        args: { issue: n, repo: repo ?? null },
      },
      config,
    );
    if (rejected) return rejected;

    const ref = { owner: t.owner, repo: t.repo, issue_number: n };
    if (facts.issue.state === "closed") await t.gh.rest.issues.update({ ...ref, state: "open" });
    for (const name of ["agent:failed", "agent:blocked"]) {
      if (facts.issue.labels.includes(name)) await t.gh.rest.issues.removeLabel({ ...ref, name });
    }
    await t.gh.rest.issues.addLabels({ ...ref, labels: ["agent:ready", "antigravity"] });
    await t.gh.rest.issues.createComment({
      ...ref,
      body: "🔁 Re-queued from Telegram by the founder. agent-dispatch picks up this same issue on its next run.",
    });
    const started = await startDispatchJob(n, t.slug, "build");

    const auditRes = await writeAuditEntry({
      action: "requeue_antigravity_task",
      idempotency_key: key,
      payload: { issue_number: n, repo: t.slug, url: facts.issue.url },
      tenant_id: TENANT,
    });
    if (!auditRes.written) log.warn({ key }, "writeAuditEntry conflict on requeue_antigravity_task");

    const when = facts.quotaUntil && facts.quotaUntil > new Date()
      ? `Antigravity's quota is exhausted until ${facts.quotaUntil.toISOString().slice(0, 16).replace("T", " ")} UTC, so it starts then.`
      : "Its run started now and reports back here.";
    const warn = started.status === "failed" ? `\n⚠️ ${startFailureNote(n, t.slug, started.reason)}` : "";
    return `✅ #${n} is back in Antigravity's queue (same issue, nothing new filed). ${when}${warn}\n${facts.issue.url}`;
  },
  {
    name: "requeue_antigravity_task",
    description:
      "Put an EXISTING Antigravity issue back in the queue (requires founder approval) — for 'dispatch it again', " +
      "'retry #N', 'it hasn't been picked up, dispatch it'. Re-opens a closed issue that never merged, clears " +
      "agent:failed, sets agent:ready. Refuses while the task is working, in review, blocked or merged. " +
      "Never use dispatch_antigravity_task for work that already has an issue.",
    schema,
  },
);
