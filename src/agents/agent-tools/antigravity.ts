/**
 * Engineering department tool — Dispatch task to Google Antigravity.
 * HITL-gated: pauses for founder approval before creating the GitHub issue.
 *
 * The brief is linted BEFORE the approval card, so the founder is never asked to approve a
 * brief that would then be rejected (nine sections filled). A cited path that does not exist is
 * not a rejection: it is demoted to an unverified hint and the card says so (see
 * ../../tools/dispatch-brief-repair.ts for why refusing it left every plain-English /task dead).
 * The lint is read-only, which is what the hitlGate contract requires of everything above the
 * gate: this body runs again from the top when the founder approves.
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import {
  describeBriefRejection,
  dispatchAntigravityTool,
  formatAntigravityIssueBody,
  lintDispatchBrief,
  resolveDispatchRepo,
  type AntigravityTaskInput,
} from "../../tools/dispatch-antigravity.js";
import { prepareDispatchBrief, type PreparedBrief } from "../../tools/dispatch-brief-repair.js";
import { renderCardPreview } from "../../tools/dispatch-brief-preview.js";
import { DISPATCH_REPO_ALLOWLIST } from "../../tools/dispatch-repos.js";
import { ENGINES, engineDisplay, engineLabel, parseEngine, readDefaultEngine } from "../../tools/coding-engine.js";
import { LABEL_SPEC } from "../../tools/pipeline-pending.js";
import { specDraftingReply, specIntakeOn } from "../../tools/dispatch-spec-intake.js";
import { childLogger } from "../../infra/logger.js";
import { hitlGate, idemKey } from "./hitl.js";
import { queueExistingIssue, target as existingTarget } from "./existing-issue-dispatch.js";
import { parseIssueReference } from "../../tools/existing-issue.js";
import { NO_ACTION_PREFIX } from "../tool-result.js";
import { hasBeenAudited, writeAuditEntry } from "../../db/queries.js";
import { TENANT } from "../../core/config.js";

const log = childLogger({ module: "agent-tools:antigravity" });

/** The model's own input for the card, except the sections that were blank and were filled from the founder's sentence. */
function cardInput(input: AntigravityTaskInput, prepared: Extract<PreparedBrief, { ok: true }>): AntigravityTaskInput {
  return {
    ...input,
    goal: prepared.filled.includes("Goal") ? prepared.input.goal : input.goal,
    expected: prepared.filled.includes("Expected") ? prepared.input.expected : input.expected,
    verification: prepared.filled.includes("Verification") ? prepared.input.verification : input.verification,
  };
}

export const dispatchAntigravityTask = tool(
  async (
    { title, goal, scope: givenScope, expected, verification, acceptance, forbidden, problem, evidence, constraints, new_files, repo, founder_request, engine },
    config,
  ) => {
    // goal, expected and verification are optional in the schema: a cheap planner that omits one must not bounce
    // before the founder sees a card. They are filled from his sentence below (withFounderRequestBrief); without
    // the sentence there is nothing to fill them from, and this refuses as text to the model, never as a question.
    const request = founder_request?.trim() ?? "";
    if (!request && [goal, expected, verification].some((v) => !v?.trim())) {
      return (
        "❌ Cannot dispatch: goal, expected and verification are missing and founder_request was not passed. " +
        "Pass the founder's message, copied verbatim, as founder_request: the missing sections are filled from it. " +
        "Do not ask the founder for them, for a file path or for a command."
      );
    }
    // No file named is normal for a one-line request: the brief files it as "paths: agent to locate" (dispatch-brief-repair.ts).
    const scope = givenScope ?? "";
    // Resolve BEFORE the gate, and refuse rather than fall back.
    //
    // This used to swallow the failure and default to FounderOS, which meant a request
    // naming another repo rendered a card reading "Open agent:ready issue on
    // pushkarverma3698/FounderOS" — the founder would approve a target the card
    // misreported, and only then would execute() fail. A refusal here is also pure and
    // re-runnable, which the hitlGate contract requires of everything above the gate
    // (src/infra/hitl.ts).
    let target: { owner: string; repo: string };
    try {
      target = await resolveDispatchRepo(repo ?? undefined);
    } catch (err) {
      return `❌ Cannot dispatch: ${(err as Error).message}`;
    }
    const repoSlug = `${target.owner}/${target.repo}`;

    // The executor is settled HERE, before the gate, and passed to execute() by name. hitlGate re-runs this body
    // when the founder approves, so reading the default again after the tap could file for a CLI the card
    // did not show. An unknown word is refused for the same reason the repo is: a card must not misreport.
    // An engine the founder forced by typing /claude or /agy (gateway: configurable.engine) outranks the argument: the
    // planner is told it in words and may drop it.
    const forced = parseEngine(config?.configurable?.["engine"] as string | undefined);
    const executor = forced ?? (engine ? parseEngine(engine) : readDefaultEngine());
    if (!executor) return `❌ Cannot dispatch: engine "${engine}" is not one I can run. Use ${ENGINES.join(" or ")}.`;
    const who = engineDisplay(executor);

    // Work that already has an issue is never filed again (prod 2026-10-07: "Start work on issue #41" became #83,
    // whose body was that sentence). The named issue is read, a merged fix is reported, else THAT issue is queued.
    const named = parseIssueReference(repoSlug, founder_request, title);
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
      return queueExistingIssue(t, named.number, { founderRequest: founder_request, engine: executor, action: "dispatch_antigravity_task", repoArg: repo }, config);
    }

    const input: AntigravityTaskInput = {
      title,
      goal: goal ?? "",
      scope,
      expected: expected ?? "",
      verification: verification ?? "",
      acceptance: acceptance ?? undefined,
      forbidden: forbidden ?? undefined,
      problem: problem ?? undefined,
      evidence: evidence ?? undefined,
      constraints: constraints ?? undefined,
      newFiles: new_files ?? undefined,
      repo: repo ?? undefined,
    };

    // Idempotency: prevent duplicate issue creation on HITL resume loop
    const key = idemKey("dispatch_antigravity", repoSlug, title, scope, executor);
    if (await hasBeenAudited(key)) {
      return `${NO_ACTION_PREFIX} Already dispatched earlier: "${title}" on ${repoSlug}. Nothing new was filed, and this does not mean an agent has picked it up.`;
    }

    // The lint comes after the idempotency check (an already-dispatched brief needs none) and
    // before the card. A brief that still fails after the repair is returned to the model as text:
    // it fixes exactly what is named and calls again, and no approval is spent on it.
    const prepared = await prepareDispatchBrief(input, founder_request, {
      lint: (candidate) => lintDispatchBrief(target, candidate),
      format: formatAntigravityIssueBody,
    });
    if (!prepared.ok) return `❌ ${describeBriefRejection(prepared.lint, repoSlug)}`;

    const rejected = await hitlGate(
      {
        action: "dispatch_antigravity_task",
        title: `🤖 Dispatch task to ${who}?`,
        summary: `Open ${specIntakeOn() ? LABEL_SPEC : "agent:ready"} issue on ${repoSlug} for ${who}: "${title}"`,
        // A digest, not the raw body: the card cuts its preview at 1500 characters and the raw
        // body would lose Verification and Acceptance first (see dispatch-brief-preview.ts).
        // The model's own scope is shown, not the repaired one (whose hint block would fill the field): the
        // demotion is named on the "Not verified" line instead.
        // A section filled from his sentence is shown as filled (the model's own blank would render an empty line).
        preview: renderCardPreview(cardInput(input, prepared), { bodyChars: prepared.body.length, warnings: prepared.warnings, filled: prepared.filled }),
        args: { title, goal, scope, expected, verification, acceptance, forbidden, problem, evidence, constraints, new_files, repo, founder_request, engine: executor },
      },
      config,
    );
    if (rejected) return rejected;

    const res = await dispatchAntigravityTool.execute({
      title,
      ...(goal ? { goal } : {}),
      scope,
      ...(expected ? { expected } : {}),
      ...(verification ? { verification } : {}),
      engine: executor,
      ...(acceptance ? { acceptance } : {}),
      ...(forbidden ? { forbidden } : {}),
      ...(problem ? { problem } : {}),
      ...(evidence ? { evidence } : {}),
      ...(constraints ? { constraints } : {}),
      ...(new_files ? { new_files } : {}),
      ...(repo ? { repo } : {}),
      ...(founder_request ? { founder_request } : {}),
    });

    if (!res.success) {
      log.error({ title, repoSlug, error: res.error }, "dispatchAntigravityTask failed");
      return `❌ Failed to dispatch task to ${who}: ${res.error}`;
    }

    const data = res.data as { issue_number: number; issue_url: string; title: string; repo: string; labels?: string[]; warnings?: string[] };

    const auditRes = await writeAuditEntry({
      action: "dispatch_antigravity_task",
      idempotency_key: key,
      payload: { issue_number: data.issue_number, title, repo: data.repo, url: data.issue_url },
      tenant_id: TENANT,
    });
    if (!auditRes.written) {
      log.warn({ key, action: "dispatch_antigravity_task" }, "writeAuditEntry conflict on dispatch_antigravity_task");
    }

    const warned = data.warnings?.length ? `\n${data.warnings.map((w) => `⚠️ ${w}`).join("\n")}` : "";
    // What was filed decides the reply: an agent:spec issue is not queued for building, so it never says it is.
    if (data.labels?.includes(LABEL_SPEC)) {
      return specDraftingReply({ who, issue: data.issue_number, repo: data.repo, url: data.issue_url, engineLabel: engineLabel(executor) }) + warned;
    }
    return (
      `✅ Dispatched to ${who}: Issue #${data.issue_number} opened on ${data.repo} with labels 'agent:ready' and '${engineLabel(executor)}'.\n` +
      `URL: ${data.issue_url}\n` +
      `Its run started now: Antigravity implements it in an isolated workspace, submits a draft PR to beta, and the review card follows here.` +
      warned
    );
  },
  {
    name: "dispatch_antigravity_task",
    description:
      "Dispatch an engineering or coding task to a coding CLI on the VPS (Google Antigravity or Claude Code, see engine) via GitHub issue (requires founder approval). " +
      "Use when asked to hand off or dispatch work to Google Antigravity, or when engineering tasks involve modifying FounderOS itself. " +
      "A request that names an existing issue (#41, 'issue 41', an issue URL) never files a new one: that issue is read, a merged fix is reported, otherwise it is queued. " +
      "Formats a complete self-contained ticket conforming to .github/ISSUE_TEMPLATE/agent-task.md and opens an issue with the 'agent:ready' label. " +
      "ALWAYS pass founder_request (his own words, verbatim): goal, expected and verification you leave out are filled from it, so a one-line request is enough. Never ask the founder for a file path or a command. Do not guess file paths: name a path only if you saw it in a tool result, " +
      "otherwise describe the subsystem in words and Antigravity, which reads the whole repository, finds the files. " +
      "The brief is checked before approval: every section filled; if it names exactly what is missing, fix that and call this tool again in the same turn, " +
      "and ask the founder only for a fact that only he knows. " +
      "Its run starts at once on the VPS, implements it in an isolated workspace, and submits a draft PR to beta; an independent reviewer (pr-brain) then reviews it.",
    schema: z.object({
      title: z.string().describe("Concise task title with conventional commit prefix (e.g. 'feat: 13k ATS scaling with per-domain rate limiting')."),
      goal: z.string().optional().nullable().describe(
        "What 'done' means in 1-2 paragraphs to an executor with no prior context. Leave it out when unsure: it is filled from founder_request.",
      ),
      scope: z.string().optional().nullable().describe(
        "The files or subsystem in scope, in plain words. Leave it out when you saw no file: it is filed as 'paths: agent to locate'. Cite a file path ONLY if you saw it in a tool result: a cited path that does " +
          "not exist is filed as an unverified hint, not an error, and Antigravity locates the real files. Never guess a path. " +
          "Paths the task will create go in new_files.",
      ),
      expected: z.string().optional().nullable().describe(
        "Detailed expected behavior, architecture specifications, algorithms, or requirements. Leave it out when unsure: it is filled from founder_request.",
      ),
      verification: z.string().optional().nullable().describe(
        "Exact shell commands whose raw output proves the fix (e.g. 'pnpm test tests/unit/tools/free-ats-source.test.ts && pnpm gate'). " +
          "Leave it out when you do not know the repository's commands: it is filed as the repository's own checks.",
      ),
      acceptance: z.string().optional().nullable().describe("Acceptance criteria the independent reviewer (pr-brain) checks before it clears the PR."),
      forbidden: z.string().optional().nullable().describe("Task-specific prohibitions beyond general standards."),
      problem: z.string().optional().nullable().describe(
        "What is actually happening today, or what is missing: exact error text, observed behavior, or the gap the founder described, " +
          "in his words. The brief is rejected while this is empty.",
      ),
      evidence: z.string().optional().nullable().describe(
        "Proof for the problem: log lines, file:line references, links to earlier investigation. Never invent it. " +
          "If the founder gave none, leave this out and pass founder_request instead.",
      ),
      founder_request: z.string().optional().nullable().describe(
        "The founder's own words, copied verbatim from his message. Always pass it: when no evidence was given it is filed as the " +
          "evidence, so a request with no log or error attached is still a complete brief.",
      ),
      constraints: z.string().optional().nullable().describe(
        "Task-specific constraints that shape the fix (performance, contracts that must not change). " +
          "The standing rules from STANDARDS.md are added automatically.",
      ),
      new_files: z.string().optional().nullable().describe(
        "Paths this task will CREATE (one per line). They do not exist yet, so they are not checked. For an audit, explanation or " +
          "research request, the deliverable is a report committed under docs/: list it here.",
      ),
      // z.string() and not z.enum for the same reason as repo below: an unknown word gets the actionable refusal, not a schema throw.
      engine: z.string().optional().nullable().describe(
        `Which coding CLI implements it: ${ENGINES.join(" or ")} (agy = Antigravity, claude = Claude Code). ` +
          "Pass it EXACTLY as the instruction says. When the instruction names none, leave it out: the founder's default applies.",
      ),
      // Deliberately z.string() and not z.enum(DISPATCH_REPO_ALLOWLIST): a Zod enum is
      // validated by LangChain BEFORE this tool's body runs, so an off-list value would
      // throw a generic schema error instead of the actionable refusal
      // assertAllowedRepo writes. Tools in this codebase return messages, they do not
      // throw (docs/rules/TOOL-STANDARDS.md). The allowlist is named here so the model
      // sees the valid choices, and enforced at runtime in resolveDispatchRepo.
      repo: z
        .string()
        .optional()
        .nullable()
        .describe(
          `Target repository slug. Only these are permitted: ${DISPATCH_REPO_ALLOWLIST.join(", ")}. ` +
            "Defaults to pushkarverma3698/FounderOS.",
        ),
    }),
  },
);
