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
import { prepareDispatchBrief } from "../../tools/dispatch-brief-repair.js";
import { renderCardPreview } from "../../tools/dispatch-brief-preview.js";
import { DISPATCH_REPO_ALLOWLIST } from "../../tools/dispatch-repos.js";
import { childLogger } from "../../infra/logger.js";
import { hitlGate, idemKey } from "./hitl.js";
import { hasBeenAudited, writeAuditEntry } from "../../db/queries.js";
import { TENANT } from "../../core/config.js";

const log = childLogger({ module: "agent-tools:antigravity" });

export const dispatchAntigravityTask = tool(
  async (
    { title, goal, scope, expected, verification, acceptance, forbidden, problem, evidence, constraints, new_files, repo, founder_request },
    config,
  ) => {
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

    const input: AntigravityTaskInput = {
      title,
      goal,
      scope,
      expected,
      verification,
      acceptance: acceptance ?? undefined,
      forbidden: forbidden ?? undefined,
      problem: problem ?? undefined,
      evidence: evidence ?? undefined,
      constraints: constraints ?? undefined,
      newFiles: new_files ?? undefined,
      repo: repo ?? undefined,
    };

    // Idempotency: prevent duplicate issue creation on HITL resume loop
    const key = idemKey("dispatch_antigravity", repoSlug, title, scope);
    if (await hasBeenAudited(key)) {
      return `Already dispatched: "${title}" on ${repoSlug} (skipped duplicate)`;
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
        title: "🤖 Dispatch task to Google Antigravity?",
        summary: `Open agent:ready issue on ${repoSlug}: "${title}"`,
        // A digest, not the raw body: the card cuts its preview at 1500 characters and the raw
        // body would lose Verification and Acceptance first (see dispatch-brief-preview.ts).
        // The model's own scope is shown, not the repaired one (whose hint block would fill the field): the
        // demotion is named on the "Not verified" line instead.
        preview: renderCardPreview(input, { bodyChars: prepared.body.length, warnings: prepared.warnings }),
        args: { title, goal, scope, expected, verification, acceptance, forbidden, problem, evidence, constraints, new_files, repo, founder_request },
      },
      config,
    );
    if (rejected) return rejected;

    const res = await dispatchAntigravityTool.execute({
      title,
      goal,
      scope,
      expected,
      verification,
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
      return `❌ Failed to dispatch task to Antigravity: ${res.error}`;
    }

    const data = res.data as { issue_number: number; issue_url: string; title: string; repo: string; warnings?: string[] };

    const auditRes = await writeAuditEntry({
      action: "dispatch_antigravity_task",
      idempotency_key: key,
      payload: { issue_number: data.issue_number, title, repo: data.repo, url: data.issue_url },
      tenant_id: TENANT,
    });
    if (!auditRes.written) {
      log.warn({ key, action: "dispatch_antigravity_task" }, "writeAuditEntry conflict on dispatch_antigravity_task");
    }

    return (
      `✅ Dispatched to Google Antigravity: Issue #${data.issue_number} opened on ${data.repo} with label 'agent:ready'.\n` +
      `URL: ${data.issue_url}\n` +
      `The VPS agent-dispatch loop will pick it up on its next tick (within 15 minutes), implement the task in an isolated workspace, and submit a draft PR to beta.` +
      (data.warnings?.length ? `\n${data.warnings.map((w) => `⚠️ ${w}`).join("\n")}` : "")
    );
  },
  {
    name: "dispatch_antigravity_task",
    description:
      "Dispatch an engineering or coding task to Google Antigravity on the VPS via GitHub issue (requires founder approval). " +
      "Use when asked to hand off or dispatch work to Google Antigravity, or when engineering tasks involve modifying FounderOS itself. " +
      "Formats a complete self-contained ticket conforming to .github/ISSUE_TEMPLATE/agent-task.md and opens an issue with the 'agent:ready' label. " +
      "ALWAYS pass founder_request (his own words, verbatim). Do not guess file paths: name a path only if you saw it in a tool result, " +
      "otherwise describe the subsystem in words and Antigravity, which reads the whole repository, finds the files. " +
      "The brief is checked before approval: every section filled; if it names exactly what is missing, fix that and call this tool again in the same turn, " +
      "and ask the founder only for a fact that only he knows. " +
      "The VPS agent-dispatch daemon claims it within a minute, implements it in an isolated workspace, and submits a draft PR to beta; an independent reviewer (pr-brain) then reviews it.",
    schema: z.object({
      title: z.string().describe("Concise task title with conventional commit prefix (e.g. 'feat: 13k ATS scaling with per-domain rate limiting')."),
      goal: z.string().describe("What 'done' means in 1-2 paragraphs to an executor with no prior context."),
      scope: z.string().describe(
        "The files or subsystem in scope, in plain words. Cite a file path ONLY if you saw it in a tool result: a cited path that does " +
          "not exist is filed as an unverified hint, not an error, and Antigravity locates the real files. Never guess a path. " +
          "Paths the task will create go in new_files.",
      ),
      expected: z.string().describe("Detailed expected behavior, architecture specifications, algorithms, or requirements."),
      verification: z.string().describe("Exact shell commands whose raw output proves the fix (e.g. 'pnpm test tests/unit/tools/free-ats-source.test.ts && pnpm gate')."),
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
