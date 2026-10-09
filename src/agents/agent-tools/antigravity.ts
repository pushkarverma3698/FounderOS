/**
 * Engineering department tool — hand one coding job to the VPS (Antigravity or Claude Code).
 * HITL-gated: one card, then the issue is filed (or an existing one queued) and its run starts.
 *
 * AG-062: FounderOS decides WHICH issue and carries the founder's words; the coding tool decides HOW. The words come
 * from the gateway (src/tools/founder-words.ts), never from a model argument: on 2026-10-09 the worker wrote planner
 * text into `founder_request` and a billing test was built for a request about #115. A new issue is his words,
 * verbatim, under the model's title. Everything above hitlGate is a read: this body runs again from the top when the
 * founder approves (src/infra/hitl.ts).
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { fileDispatchIssue, resolveDispatchRepo } from "../../tools/dispatch-antigravity.js";
import { DISPATCH_REPO_ALLOWLIST } from "../../tools/dispatch-repos.js";
import { checkRepoReach } from "../../tools/repo-reach.js";
import { Octokit } from "octokit";
import { ENGINES, engineDisplay, engineLabel, parseEngine, readDefaultEngine } from "../../tools/coding-engine.js";
import { founderWordsFrom } from "../../tools/founder-words.js";
import { childLogger } from "../../infra/logger.js";
import { hitlGate, idemKey } from "./hitl.js";
import { queueExistingIssue, target as existingTarget } from "./existing-issue-dispatch.js";
import { parseIssueReference } from "../../tools/existing-issue.js";
import { NO_ACTION_PREFIX } from "../tool-result.js";
import { hasBeenAudited, writeAuditEntry } from "../../db/queries.js";
import { TENANT } from "../../core/config.js";

const log = childLogger({ module: "agent-tools:antigravity" });

export const dispatchAntigravityTask = tool(
  async ({ title, goal, problem, evidence, repo, engine }, config) => {
    // Resolve BEFORE the gate, and refuse rather than fall back: a card must never name a repo the run will not use.
    let target: { owner: string; repo: string };
    try {
      target = await resolveDispatchRepo(repo ?? undefined);
    } catch (err) {
      return `❌ Cannot dispatch: ${(err as Error).message}`;
    }
    const repoSlug = `${target.owner}/${target.repo}`;

    // The executor is settled HERE, before the gate: reading the default again after the tap could file for a CLI the
    // card did not show. An engine the founder forced by typing /claude or /agy (configurable.engine) outranks the argument.
    const forced = parseEngine(config?.configurable?.["engine"] as string | undefined);
    const executor = forced ?? (engine ? parseEngine(engine) : readDefaultEngine());
    if (!executor) return `❌ Cannot dispatch: engine "${engine}" is not one I can run. Use ${ENGINES.join(" or ")}.`;
    const who = engineDisplay(executor);
    const words = founderWordsFrom(config?.configurable).trim();

    // Work that already has an issue is never filed again (prod 2026-10-07: "Start work on issue #41" became #83).
    // His words are read first: on 10-09 the model's title named no number while his message named #115.
    const named = parseIssueReference(repoSlug, words, title, goal, problem, evidence);
    if (named.kind === "many") {
      const list = named.numbers.map((x) => `#${x}`).join(", ");
      return (
        `${NO_ACTION_PREFIX} the request names more than one existing issue (${list}) on ${repoSlug}. Nothing was filed. ` +
        `Queue them one at a time with requeue_antigravity_task (${named.numbers.map((x) => `issue=${x}`).join(", then ")}).`
      );
    }
    if (named.kind === "one") {
      const t = await existingTarget(repoSlug);
      if (typeof t === "string") return t;
      return queueExistingIssue(t, named.number, { founderWords: words, engine: executor, action: "dispatch_antigravity_task", repoArg: repo }, config);
    }

    if (!words) return "❌ Cannot dispatch: the founder's message did not reach this tool, so there is nothing to file. Nothing was filed.";

    // Idempotency: prevent duplicate issue creation on HITL resume loop
    const key = idemKey("dispatch_antigravity", repoSlug, title, words, executor);
    if (await hasBeenAudited(key)) {
      return `${NO_ACTION_PREFIX} Already dispatched earlier: "${title}" on ${repoSlug}. Nothing new was filed, and this does not mean an agent has picked it up.`;
    }

    // Before the card, so the founder is never asked to approve a filing on a repo the bot's token cannot reach (AG-039).
    const token = process.env["GITHUB_TOKEN"];
    if (token) {
      const reach = await checkRepoReach(target, new Octokit({ auth: token }));
      if (!reach.ok) return `❌ Cannot dispatch: ${reach.message}`;
    }

    const rejected = await hitlGate(
      {
        action: "dispatch_antigravity_task",
        title: `🤖 File a new issue for ${who}?`,
        summary: `New issue on ${repoSlug}: "${title}" → ${who}, labels agent:ready, antigravity, ${engineLabel(executor)}`,
        preview: `Your words, filed as the issue body:\n“${words}”`,
        args: { title, repo: repo ?? null, founder_words: words, engine: executor },
      },
      config,
    );
    if (rejected) return rejected;

    const res = await fileDispatchIssue({ ...target, title, words, engine: executor });
    if (!res.ok) {
      log.error({ title, repoSlug, error: res.error }, "dispatchAntigravityTask failed");
      return `❌ Failed to dispatch task to ${who}: ${res.error}`;
    }
    const { job } = res;

    const auditRes = await writeAuditEntry({
      action: "dispatch_antigravity_task",
      idempotency_key: key,
      payload: { issue_number: job.issueNumber, title, repo: job.repo, url: job.issueUrl },
      tenant_id: TENANT,
    });
    if (!auditRes.written) {
      log.warn({ key, action: "dispatch_antigravity_task" }, "writeAuditEntry conflict on dispatch_antigravity_task");
    }

    return (
      `✅ Dispatched to ${who}: Issue #${job.issueNumber} opened on ${job.repo} with labels 'agent:ready' and '${engineLabel(executor)}'.\n` +
      `URL: ${job.issueUrl}\n` +
      `Its run started now: ${who} implements it in an isolated workspace and opens a draft PR to beta; after the repo's CI and the review, the Merge or Fix-it card follows here.` +
      (job.warning ? `\n⚠️ ${job.warning}` : "")
    );
  },
  {
    name: "dispatch_antigravity_task",
    description:
      "Hand a coding task to a coding CLI on the VPS (Google Antigravity or Claude Code, see engine) via a GitHub issue (requires founder approval). " +
      "Use for any request to build, fix or change code in a repository the repo field lists. " +
      "The founder's message is read by the tool itself and filed verbatim as the issue body: pass only a short title with a conventional-commit prefix. " +
      "A request that names an existing issue (#41, 'issue 41', an issue URL) never files a new one: that issue is read, a merged fix is reported, otherwise it is queued. " +
      "Never ask the founder for a file path or a command. Its run starts at once on the VPS and opens a draft PR to beta; the repo's CI and an independent review (pr-brain) follow.",
    schema: z.object({
      title: z.string().describe("Short issue title with a conventional-commit prefix (e.g. 'fix(auth): unknown users get 404 on /login')."),
      goal: z.string().optional().nullable().describe("Optional. Not filed (his words are); read only to spot an existing issue number."),
      problem: z.string().optional().nullable().describe("Optional. Not filed; read only to spot an existing issue number."),
      evidence: z.string().optional().nullable().describe("Optional. Not filed; read only to spot an existing issue number."),
      // z.string() and not z.enum for the same reason as repo below: an unknown word gets the actionable refusal, not a schema throw.
      engine: z.string().optional().nullable().describe(
        `Which coding CLI implements it: ${ENGINES.join(" or ")} (agy = Antigravity, claude = Claude Code). ` +
          "Pass it EXACTLY as the instruction says. When the instruction names none, leave it out: the founder's default applies.",
      ),
      // Deliberately z.string() and not z.enum(DISPATCH_REPO_ALLOWLIST): a Zod enum is validated by LangChain BEFORE this
      // body runs, so an off-list value would throw a generic schema error instead of the actionable refusal.
      repo: z
        .string()
        .optional()
        .nullable()
        .describe(`Target repository slug. Only these are permitted: ${DISPATCH_REPO_ALLOWLIST.join(", ")}. Defaults to pushkarverma3698/FounderOS.`),
    }),
  },
);
