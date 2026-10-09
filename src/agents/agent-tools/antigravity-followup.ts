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
import { describeTaskStatus, fetchTaskFacts } from "../../tools/antigravity-status.js";
import { queueExistingIssue, target, type Target } from "./existing-issue-dispatch.js";

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

const requeueSchema = schema.extend({
  founder_request: z.string().optional().nullable().describe("The founder's own words, copied verbatim from his message."),
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
      "Never answer those from list_issues, and never promise to monitor: this answer names the real notifications. " +
      "Relay the answer as written: keep the branch, EVERY blocker line, the fix-round count and the next-step time. " +
      "Never drop a blocker, and never say a review is incomplete or unexplained when the answer lists a verdict.",
    schema,
  },
);

export const requeueAntigravityTask = tool(
  async ({ issue, repo, founder_request }, config) => {
    const t = await target(repo);
    if (typeof t === "string") return t;
    let n: number | undefined;
    try {
      n = await resolveIssue(t, issue);
    } catch (err) {
      return `❌ Could not read the task on ${t.slug}: ${(err as Error).message}`;
    }
    if (n === undefined) return `No Antigravity issue found on ${t.slug}.`;
    return queueExistingIssue(t, n, { founderRequest: founder_request, action: "requeue_antigravity_task", repoArg: repo }, config);
  },
  {
    name: "requeue_antigravity_task",
    description:
      "Queue an EXISTING issue (requires founder approval) — for 'start work on #N', 'dispatch it again', " +
      "'retry #N', 'it hasn't been picked up, dispatch it'. Reads the issue first: if a merged PR already fixes it, " +
      "says so with the link and queues nothing. Re-opens a closed issue that never merged, clears agent:failed, " +
      "sets agent:ready (agent:spec for an issue no agent has had, when the spec pipeline is on). When pr-brain " +
      "BLOCKED the issue's PR, this is the tool for 'fix it' / 'dispatch agy to fix the issues in the same branch': one card " +
      "lists every blocker, then the fix starts NOW on that PR's branch (no cron wait, no new issue). Refuses, with the real " +
      "reason, only for a merged fix, a run claimed under 60 min ago, a PR pr-brain has not reviewed yet or one it cleared. " +
      "Never tell the founder it is 'already working' unless the answer says a run claimed it. Pass founder_request (his words, verbatim). " +
      "Never use dispatch_antigravity_task to file a new issue for work that already has one.",
    schema: requeueSchema,
  },
);
