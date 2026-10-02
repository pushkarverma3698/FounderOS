/**
 * Engineering department tool — Dispatch task to Google Antigravity.
 * HITL-gated: pauses for founder approval before creating the GitHub issue.
 *
 * The brief is linted BEFORE the approval card, so the founder is never asked to approve a
 * brief that would then be rejected (nine sections filled, every cited path real). The lint is
 * read-only, which is what the hitlGate contract requires of everything above the gate: this
 * body runs again from the top when the founder approves.
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
import { renderCardPreview } from "../../tools/dispatch-brief-preview.js";
import { DISPATCH_REPO_ALLOWLIST } from "../../tools/dispatch-repos.js";
import { childLogger } from "../../infra/logger.js";
import { hitlGate, idemKey } from "./hitl.js";
import { hasBeenAudited, writeAuditEntry } from "../../db/queries.js";
import { TENANT } from "../../core/config.js";

const log = childLogger({ module: "agent-tools:antigravity" });

export const dispatchAntigravityTask = tool(
  async (
    { title, goal, scope, expected, verification, acceptance, forbidden, problem, evidence, constraints, new_files, repo },
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
    const previewBody = formatAntigravityIssueBody(input);

    // Idempotency: prevent duplicate issue creation on HITL resume loop
    const key = idemKey("dispatch_antigravity", repoSlug, title, scope);
    if (await hasBeenAudited(key)) {
      return `Already dispatched: "${title}" on ${repoSlug} (skipped duplicate)`;
    }

    // The lint comes after the idempotency check (an already-dispatched brief needs none) and
    // before the card. A brief that fails is returned to the model as text: it asks the founder
    // for the missing piece, and no approval is spent on it.
    const lint = await lintDispatchBrief(target, previewBody);
    if (!lint.ok) return `❌ ${describeBriefRejection(lint, repoSlug)}`;

    const rejected = await hitlGate(
      {
        action: "dispatch_antigravity_task",
        title: "🤖 Dispatch task to Google Antigravity?",
        summary: `Open agent:ready issue on ${repoSlug}: "${title}"`,
        // A digest, not the raw body: the card cuts its preview at 1500 characters and the raw
        // body would lose Verification and Acceptance first (see dispatch-brief-preview.ts).
        preview: renderCardPreview(input, { bodyChars: previewBody.length, warnings: lint.warnings }),
        args: { title, goal, scope, expected, verification, acceptance, forbidden, problem, evidence, constraints, new_files, repo },
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
      "The brief is checked before approval: every section filled (including problem and evidence) and every file in scope real. " +
      "If the tool returns a brief rejection, YOU MUST verbatim repeat the exact missing pieces to the user and ask for them. DO NOT paraphrase the rejection reason, and DO NOT guess. " +
      "The VPS agent-dispatch daemon claims it within 15 minutes, implements it in an isolated workspace, and submits a draft PR to beta.",
    schema: z.object({
      title: z.string().describe("Concise task title with conventional commit prefix (e.g. 'feat: 13k ATS scaling with per-domain rate limiting')."),
      goal: z.string().describe("What 'done' means in 1-2 paragraphs to an executor with no prior context."),
      scope: z.string().describe(
        "Exact files or subsystems in scope (e.g. 'src/tools/jobhunt/free-ats-source.ts'). Every path must exist today, " +
          "or the brief is rejected; paths the task will create go in new_files.",
      ),
      expected: z.string().describe("Detailed expected behavior, architecture specifications, algorithms, or requirements."),
      verification: z.string().describe("Exact shell commands whose raw output proves the fix (e.g. 'pnpm test tests/unit/tools/free-ats-source.test.ts && pnpm gate')."),
      acceptance: z.string().optional().nullable().describe("Acceptance criteria for Claude pr-brain review before PASS."),
      forbidden: z.string().optional().nullable().describe("Task-specific prohibitions beyond general standards."),
      problem: z.string().optional().nullable().describe(
        "What is actually happening today, or what is missing: exact error text, observed behavior, or the gap the founder described. " +
          "Ask the founder if unknown; never invent it. The brief is rejected while this is empty.",
      ),
      evidence: z.string().optional().nullable().describe(
        "Proof for the problem: log lines, file:line references, links to earlier investigation. " +
          "Ask the founder if he gave none; never invent it. The brief is rejected while this is empty.",
      ),
      constraints: z.string().optional().nullable().describe(
        "Task-specific constraints that shape the fix (performance, contracts that must not change). " +
          "The standing rules from STANDARDS.md are added automatically.",
      ),
      new_files: z.string().optional().nullable().describe(
        "Paths this task will CREATE (one per line). They do not exist yet, so they are not checked; everything in scope must exist today.",
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
