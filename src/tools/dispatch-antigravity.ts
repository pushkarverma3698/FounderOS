/**
 * FounderOS — Antigravity Dispatch Tool
 * ========================================
 * Formats a self-contained engineering brief conforming to .github/ISSUE_TEMPLATE/agent-task.md
 * and opens a GitHub issue on pushkarverma3698/FounderOS with the `agent:ready` label.
 *
 * This connects FounderOS to the VPS autonomous loop (ADR-046):
 *   Telegram / Founder → dispatch_antigravity_task → GitHub Issue (agent:ready)
 *     → agent-dispatch (VPS cron, every 15 min) → Antigravity CLI (`agy`) → draft PR to beta
 *     → pr-brain (independent review, every 20 min) → Merge
 *
 * Architecture Invariants (ADR-046 & ISSUE-DRIVEN-CONTRACT.md):
 *   - Issues are the ONLY dispatch mechanism for Antigravity.
 *   - The issue must contain all nine template sections, filled, and name only files that
 *     exist, so the headless executor can run with zero conversation history. That is
 *     enforced here, before `issues.create`, by ./agent-brief-lint.ts: a brief that fails is
 *     never filed, and the reason goes back to the model so it asks the founder. The lint
 *     also runs BEFORE the approval card (agents/agent-tools/antigravity.ts), so the founder
 *     is never asked to approve a brief that would then be rejected.
 *
 * TARGET REPO IS PINNED TO AN ALLOWLIST (./dispatch-repos.ts). `repo` is a
 * caller-supplied argument that takes precedence over ISSUE_REPO, so without the
 * allowlist the model could name any repository this GITHUB_TOKEN can write to — and
 * the token carries `repo`, `admin:org` and `delete_repo`. The two containments that
 * existed before it (the HITL card printing the resolved slug, and the VPS crontab
 * pinning ISSUE_REPO) both still apply, but neither is a boundary: a card is only as
 * good as the reading of it, and the crontab pin makes a stray issue inert rather than
 * unfiled. `assertAllowedRepo` is the boundary, and env vars pass through it too.
 */

import { Octokit } from "octokit";
import { childLogger } from "../infra/logger.js";
import { assertDispatchableRepo, DEFAULT_DISPATCH_REPO, DISPATCH_REPO_ALLOWLIST } from "./dispatch-repos.js";
import { listRegisteredDispatchRepos } from "../db/queries.js";
import { TENANT } from "../core/config.js";
import { kickDispatchTick } from "./dispatch-tick.js";
import { ENGINES, engineLabel, parseEngine, readDefaultEngine } from "./coding-engine.js";
import { DEFAULT_ACCEPTANCE_TEXT } from "./dispatch-roles.js";
import { formatBriefRejection, type BriefLintResult } from "./agent-brief-lint.js";
import { prepareDispatchBrief, type PreparedBrief } from "./dispatch-brief-repair.js";
import { checkDispatchBrief, type ContentsClient } from "./dispatch-brief-check.js";
import type { UnifiedTool, ToolResult } from "./index.js";

const log = childLogger({ module: "tool:dispatch-antigravity" });

/** Re-exported so existing importers keep one import site for the dispatch defaults. */
export { DEFAULT_DISPATCH_REPO };
export const AGENT_READY_LABEL = "agent:ready";
export const ANTIGRAVITY_LABEL = "antigravity";

export interface AntigravityTaskInput {
  title: string;
  goal: string;
  scope: string;
  expected: string;
  verification: string;
  acceptance?: string;
  forbidden?: string;
  /** What is happening today. Its own section; left empty when absent so the lint says so. */
  problem?: string;
  /** Proof for the problem. Its own section; left empty when absent so the lint says so. */
  evidence?: string;
  /** Task-specific constraints, appended to STANDING_CONSTRAINTS. */
  constraints?: string;
  /** Paths the task will create. Listed under a sub-heading of the scope section, which the lint skips. */
  newFiles?: string;
  repo?: string;
}

/**
 * Rules that hold for every task, derived from docs/antigravity/STANDARDS.md (§8 style and
 * scope, §9 tests, §10 dependencies, §11 what needs explicit instruction) and CLAUDE.md
 * (never commit or push to main). They are real content for the "Constraints" section, not a
 * placeholder: the section always carries them, with the founder's own constraints appended.
 */
export const STANDING_CONSTRAINTS: readonly string[] = [
  "Follow docs/antigravity/STANDARDS.md; where this brief is silent, it governs.",
  "Change only the files listed in scope (and their tests). Every changed line must trace to this brief.",
  "Match the surrounding code's style. Do not restyle, reformat, or delete code you were not asked to touch.",
  "Add no npm dependency, config file, or directory unless this brief asks for it.",
  "Tests must run offline and free: no real LLM, paid API, or network call.",
  "Do not edit CI config, .env files, or credentials.",
  "Work only on your task branch and open a draft PR. Never push to, or merge into, main or beta.",
];

const DEFAULT_FORBIDDEN =
  "See docs/antigravity/STANDARDS.md — do not touch /opt/founderos, never merge to main, never force-push.";
/** Exported so the approval card shows the acceptance criteria the issue will really carry. */
export const DEFAULT_ACCEPTANCE = DEFAULT_ACCEPTANCE_TEXT;

const section = (heading: string, content: string): string[] => [`## ${heading}`, "", content.trim(), ""];

/**
 * Formats structured task inputs into the standard agent-task issue body: all nine sections of
 * .github/ISSUE_TEMPLATE/agent-task.md, in the template's order.
 *
 * Problem and Evidence have no default text. They used to (`Task dispatched by Founder via
 * FounderOS.`), which is how #762 reached the executor with nothing in them. An empty section is
 * reported by the lint, and the planner asks the founder.
 */
export function formatAntigravityIssueBody(input: AntigravityTaskInput): string {
  const standing = STANDING_CONSTRAINTS.map((rule) => `- ${rule}`).join("\n");
  const own = input.constraints?.trim();
  const newFiles = input.newFiles?.trim();

  return [
    ...section("Goal", input.goal),
    ...section("Problem / observed behavior", input.problem ?? ""),
    ...section("Expected behavior", input.expected),
    ...section("Evidence", input.evidence ?? ""),
    ...section(
      "Files or subsystem in scope",
      newFiles ? `${input.scope.trim()}\n\n### New files to create\n\n${newFiles}` : input.scope,
    ),
    ...section("Constraints", own ? `${standing}\n\nTask-specific constraints:\n\n${own}` : standing),
    ...section("Explicitly forbidden", input.forbidden?.trim() || DEFAULT_FORBIDDEN),
    ...section("Verification commands", input.verification),
    ...section("Acceptance criteria", input.acceptance?.trim() || DEFAULT_ACCEPTANCE),
  ]
    .join("\n")
    .trimEnd();
}

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

/**
 * Lints a formatted brief against the repo it will be filed on: all nine sections filled, and
 * every cited path real (see ./agent-brief-lint.ts). READ-ONLY, so it is safe above hitlGate,
 * which re-runs everything above it on resume. A passing verdict is remembered for the same repo
 * and body (./dispatch-brief-check.ts), so the pre-approval call, the replay after approval and
 * execute() share one set of GitHub lookups.
 */
export function lintDispatchBrief(
  target: { owner: string; repo: string },
  body: string,
  getClient: () => ContentsClient = getOctokit,
): Promise<BriefLintResult> {
  return checkDispatchBrief({ ...target, body }, { getClient });
}

/** Which tool input fills each template section, so a rejection tells the model what to pass. */
const SECTION_INPUT_HINTS: Readonly<Record<string, string>> = {
  Goal: "Pass it in the `goal` input.",
  "Problem / observed behavior": "Pass it in the `problem` input: what the founder described, in his words.",
  "Expected behavior": "Pass it in the `expected` input.",
  Evidence:
    "Pass it in the `evidence` input. If the founder gave no log, error or reference, pass his own words, copied verbatim, in " +
    "`founder_request`: they are filed as the evidence.",
  "Files or subsystem in scope": "Pass it in the `scope` input.",
  Constraints: "Pass it in the `constraints` input.",
  "Explicitly forbidden": "Pass it in the `forbidden` input.",
  "Verification commands": "Pass it in the `verification` input.",
  "Acceptance criteria": "Pass it in the `acceptance` input.",
};

/** The rejection the model reads, and relays to the founder, when the lint fails. */
export function describeBriefRejection(lint: BriefLintResult, target: string): string {
  return formatBriefRejection(lint, {
    target,
    hints: SECTION_INPUT_HINTS,
    newFilesHint: "Pass them in the `new_files` input.",
  });
}

export const dispatchAntigravityTool: UnifiedTool = {
  name: "dispatch_antigravity_task",
  description:
    "Dispatch an engineering or coding task to Google Antigravity on the VPS via GitHub issue. " +
    "Formats the task into a structured ticket and opens an issue with the 'agent:ready' label on an allowlisted repository. " +
    "The VPS agent-dispatch daemon claims it within a minute, implements it in an isolated workspace, and submits a draft PR to beta; " +
    "an independent reviewer (pr-brain) then reviews it.",
  input_schema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Concise issue title with conventional commit prefix (e.g. 'feat: 13k ATS scaling with per-domain rate limiting').",
      },
      goal: {
        type: "string",
        description: "What 'done' means in 1-2 paragraphs to an executor with no prior context. Optional when founder_request is passed: a blank one is filled from his sentence. Required without it.",
      },
      scope: {
        type: "string",
        description:
          "The files or subsystem in scope, in plain words. Leave it out when you saw no file: it is filed as " +
          "'paths: agent to locate'. Cite a file path ONLY if you saw it in a tool result: " +
          "a cited path that does not exist is not an error, it is filed as an unverified hint and Antigravity (which reads " +
          "the whole repository) locates the real files. Never guess a path. Paths the task will create go in new_files.",
      },
      expected: {
        type: "string",
        description: "Detailed expected behavior, architecture specifications, algorithms, or requirements. Optional when founder_request is passed: a blank one is filled from his sentence. Required without it.",
      },
      verification: {
        type: "string",
        description: "Exact shell commands whose raw output proves the fix (e.g. 'pnpm test tests/unit/tools/free-ats-source.test.ts && pnpm gate'). Optional when founder_request is passed: a blank one is filled from his sentence. Required without it.",
      },
      acceptance: {
        type: "string",
        description: "Acceptance criteria the independent reviewer (pr-brain) checks before it clears the PR.",
      },
      forbidden: {
        type: "string",
        description: "Task-specific prohibitions beyond general standards.",
      },
      problem: {
        type: "string",
        description:
          "What is actually happening today, or what is missing: exact error text, observed behavior, or the gap " +
          "the founder described, in his words. The brief is rejected while this is empty.",
      },
      evidence: {
        type: "string",
        description:
          "Proof for the problem: log lines, file:line references, links to earlier investigation. Never invent it. " +
          "If the founder gave none, leave this out and pass founder_request instead.",
      },
      founder_request: {
        type: "string",
        description:
          "The founder's own words, copied verbatim from his message. Always pass it: when no evidence was given it is " +
          "filed as the evidence, so a request with no log or error attached is still a complete brief.",
      },
      constraints: {
        type: "string",
        description:
          "Task-specific constraints that shape the fix (performance, contracts that must not change). " +
          "The standing rules from STANDARDS.md are added automatically.",
      },
      new_files: {
        type: "string",
        description:
          "Paths this task will CREATE (one per line). They do not exist yet, so they are not checked. For an audit, " +
          "explanation or research request, the deliverable is a report committed under docs/: list it here.",
      },
      repo: {
        type: "string",
        description:
          `Target repository slug. Only these are permitted: ${DISPATCH_REPO_ALLOWLIST.join(", ")}. ` +
          "Defaults to pushkarverma3698/FounderOS.",
      },
      engine: {
        type: "string",
        enum: [...ENGINES],
        description:
          "Which coding CLI implements it: 'agy' (Antigravity) or 'claude' (Claude Code). " +
          "Omit it to use the founder's current default (/engine).",
      },
    },
    // scope is not required: an empty one is filed as "paths: agent to locate" (./dispatch-brief-repair.ts). goal, expected
    // and verification are required only without founder_request (JSON schema cannot say "or"): execute() enforces it.
    required: ["title"],
  },

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const title = args["title"] as string | undefined;
    const goal = args["goal"] as string | undefined;
    const scope = (args["scope"] as string | undefined) ?? "";
    const expected = args["expected"] as string | undefined;
    const verification = args["verification"] as string | undefined;

    // A blank goal, expected or verification is filled from his sentence (withFounderRequestBrief): refused only without it.
    const noSentence = !(args["founder_request"] as string | undefined)?.trim();
    if (!title || (noSentence && [goal, expected, verification].some((v) => !v?.trim()))) {
      return {
        success: false,
        error: "dispatch_antigravity_task requires title, goal, expected, and verification commands.",
      };
    }

    const input: AntigravityTaskInput = {
      title,
      goal: goal ?? "",
      scope,
      expected: expected ?? "",
      verification: verification ?? "",
      acceptance: args["acceptance"] as string | undefined,
      forbidden: args["forbidden"] as string | undefined,
      problem: args["problem"] as string | undefined,
      evidence: args["evidence"] as string | undefined,
      constraints: args["constraints"] as string | undefined,
      newFiles: args["new_files"] as string | undefined,
      repo: args["repo"] as string | undefined,
    };
    const founderRequest = args["founder_request"] as string | undefined;

    // Refused, not defaulted: a word that is not an engine must not send work to a CLI nobody picked.
    const named = args["engine"];
    const engine = named === undefined || named === null || named === "" ? readDefaultEngine() : parseEngine(named);
    if (!engine) {
      return { success: false, error: `engine "${String(named)}" is not one I can run. Use ${ENGINES.join(" or ")}.` };
    }

    let owner: string;
    let repo: string;
    try {
      ({ owner, repo } = await resolveDispatchRepo(input.repo));
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }

    let octokit: Octokit;
    try {
      octokit = getOctokit();
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }

    // Exactly one engine label: an issue carrying both is ambiguous to the daemon, which then falls back to the default.
    const labels = [AGENT_READY_LABEL, ANTIGRAVITY_LABEL, engineLabel(engine)];

    // The gate. A brief with an empty section is never filed: the reason goes back to the model, before any
    // Antigravity tokens are spent. A cited path that does not exist is NOT such a reason (see
    // ./dispatch-brief-repair.ts): it is demoted to an unverified hint and the brief is filed.
    let prepared: PreparedBrief;
    try {
      prepared = await prepareDispatchBrief(input, founderRequest, {
        lint: (candidate) => lintDispatchBrief({ owner, repo }, candidate, () => octokit),
        format: formatAntigravityIssueBody,
      });
    } catch (err) {
      const message = (err as Error).message;
      log.error({ owner, repo, err: message }, "Brief lint crashed; nothing was filed");
      return {
        success: false,
        error: `The brief lint crashed (${message}), so nothing was filed. This is a FounderOS bug in src/tools/agent-brief-lint.ts, not a problem with the brief.`,
      };
    }
    if (!prepared.ok) {
      const { lint } = prepared;
      return {
        success: false,
        error: describeBriefRejection(lint, `${owner}/${repo}`),
        data: { missing: lint.missing, missing_headings: lint.missingHeadings, missing_paths: lint.missingPaths },
      };
    }
    const { body, warnings } = prepared;

    try {
      const { data } = await octokit.rest.issues.create({
        owner,
        repo,
        title: input.title.trim(),
        body,
        labels,
      });

      log.info({ owner, repo, issue_number: data.number, url: data.html_url }, "Dispatched issue to Antigravity");

      // Shorten the wait from "up to 15 minutes" to "seconds". Wrapped because the
      // issue is already filed at this point: nothing about claiming it sooner may
      // turn a successful dispatch into a reported failure.
      try {
        kickDispatchTick(data.number, `${owner}/${repo}`);
      } catch (err) {
        // allow-failopen: cron claims the issue on its next tick regardless.
        log.warn({ issue_number: data.number, err: (err as Error).message }, "dispatch kick failed");
      }

      return {
        success: true,
        data: {
          issue_number: data.number,
          issue_url: data.html_url,
          title: data.title,
          repo: `${owner}/${repo}`,
          engine,
          labels,
          ...(warnings.length > 0 ? { warnings } : {}),
        },
      };
    } catch (err) {
      const message = (err as Error).message;
      log.error({ owner, repo, err: message }, "Failed to create dispatch issue");
      return { success: false, error: `GitHub issue creation failed: ${message}` };
    }
  },
};
