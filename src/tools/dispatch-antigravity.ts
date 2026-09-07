/**
 * FounderOS — Antigravity Dispatch Tool
 * ========================================
 * Formats a self-contained engineering brief conforming to .github/ISSUE_TEMPLATE/agent-task.md
 * and opens a GitHub issue on pushkarverma3698/FounderOS with the `agent:ready` label.
 *
 * This connects FounderOS to the VPS autonomous loop (ADR-046):
 *   Telegram / Founder → dispatch_antigravity_task → GitHub Issue (agent:ready)
 *     → agent-dispatch (VPS cron, every 15 min) → Antigravity CLI (`agy`) → draft PR to beta
 *     → pr-brain (Claude review, every 20 min) → Merge
 *
 * Architecture Invariants (ADR-046 & ISSUE-DRIVEN-CONTRACT.md):
 *   - Issues are the ONLY dispatch mechanism for Antigravity.
 *   - The issue must contain all required sections (Goal, Scope, Verification, etc.)
 *     so the headless executor can run with zero conversation history.
 *   - Pinned to ISSUE_REPO (pushkarverma3698/FounderOS).
 */

import { Octokit } from "octokit";
import { childLogger } from "../infra/logger.js";
import type { UnifiedTool, ToolResult } from "./index.js";

const log = childLogger({ module: "tool:dispatch-antigravity" });

export const DEFAULT_DISPATCH_REPO = "pushkarverma3698/FounderOS";
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
  evidence?: string;
  repo?: string;
}

/** Formats structured task inputs into the standard agent-task issue body. */
export function formatAntigravityIssueBody(input: AntigravityTaskInput): string {
  const forbidden = input.forbidden?.trim() ||
    "See docs/antigravity/STANDARDS.md — do not touch /opt/founderos, never merge to main, never force-push.";
  const acceptance = input.acceptance?.trim() ||
    "All verification commands pass; Claude pr-brain clears review with no BLOCKER.";
  const evidence = input.evidence?.trim() ||
    "Task dispatched by Founder via FounderOS.";

  return [
    "## Goal",
    "",
    input.goal.trim(),
    "",
    "## Problem / observed behavior",
    "",
    evidence,
    "",
    "## Expected behavior",
    "",
    input.expected.trim(),
    "",
    "## Files or subsystem in scope",
    "",
    input.scope.trim(),
    "",
    "## Explicitly forbidden",
    "",
    forbidden,
    "",
    "## Verification commands",
    "",
    input.verification.trim(),
    "",
    "## Acceptance criteria",
    "",
    acceptance,
  ].join("\n");
}

function getOctokit(): Octokit {
  const token = process.env["GITHUB_TOKEN"];
  if (!token) throw new Error("GITHUB_TOKEN not configured — set it in .env");
  return new Octokit({ auth: token });
}

export function resolveDispatchRepo(repoArg?: string): { owner: string; repo: string } {
  const slug = repoArg?.trim() ||
    process.env["ISSUE_REPO"] ||
    process.env["SELF_IMPROVE_ISSUE_REPO"] ||
    DEFAULT_DISPATCH_REPO;

  const [owner, repo] = slug.split("/");
  if (!owner || !repo) {
    throw new Error(`Invalid repository slug "${slug}". Expected "owner/repo".`);
  }
  return { owner, repo };
}

export const dispatchAntigravityTool: UnifiedTool = {
  name: "dispatch_antigravity_task",
  description:
    "Dispatch an engineering or coding task to Google Antigravity on the VPS via GitHub issue. " +
    "Formats the task into a structured ticket and opens an issue on pushkarverma3698/FounderOS with the 'agent:ready' label. " +
    "The VPS agent-dispatch daemon claims it within 15 minutes, implements it in an isolated workspace, and submits a draft PR to beta.",
  input_schema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Concise issue title with conventional commit prefix (e.g. 'feat: 13k ATS scaling with per-domain rate limiting').",
      },
      goal: {
        type: "string",
        description: "What 'done' means in 1-2 paragraphs to an executor with no prior context.",
      },
      scope: {
        type: "string",
        description: "Exact files or subsystems in scope (e.g. 'src/tools/jobhunt/free-ats-source.ts').",
      },
      expected: {
        type: "string",
        description: "Detailed expected behavior, architecture specifications, algorithms, or requirements.",
      },
      verification: {
        type: "string",
        description: "Exact shell commands whose raw output proves the fix (e.g. 'pnpm test tests/unit/tools/free-ats-source.test.ts && pnpm gate').",
      },
      acceptance: {
        type: "string",
        description: "Acceptance criteria for Claude pr-brain review before PASS.",
      },
      forbidden: {
        type: "string",
        description: "Task-specific prohibitions beyond general standards.",
      },
      evidence: {
        type: "string",
        description: "Error logs, observed behavior, reproduction steps, or context.",
      },
      repo: {
        type: "string",
        description: "Target repository slug (defaults to pushkarverma3698/FounderOS).",
      },
    },
    required: ["title", "goal", "scope", "expected", "verification"],
  },

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const title = args["title"] as string | undefined;
    const goal = args["goal"] as string | undefined;
    const scope = args["scope"] as string | undefined;
    const expected = args["expected"] as string | undefined;
    const verification = args["verification"] as string | undefined;

    if (!title || !goal || !scope || !expected || !verification) {
      return {
        success: false,
        error: "dispatch_antigravity_task requires title, goal, scope, expected, and verification commands.",
      };
    }

    const input: AntigravityTaskInput = {
      title,
      goal,
      scope,
      expected,
      verification,
      acceptance: args["acceptance"] as string | undefined,
      forbidden: args["forbidden"] as string | undefined,
      evidence: args["evidence"] as string | undefined,
      repo: args["repo"] as string | undefined,
    };

    let owner: string;
    let repo: string;
    try {
      ({ owner, repo } = resolveDispatchRepo(input.repo));
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }

    let octokit: Octokit;
    try {
      octokit = getOctokit();
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }

    const body = formatAntigravityIssueBody(input);
    const labels = [AGENT_READY_LABEL, ANTIGRAVITY_LABEL];

    try {
      const { data } = await octokit.rest.issues.create({
        owner,
        repo,
        title: input.title.trim(),
        body,
        labels,
      });

      log.info({ owner, repo, issue_number: data.number, url: data.html_url }, "Dispatched issue to Antigravity");

      return {
        success: true,
        data: {
          issue_number: data.number,
          issue_url: data.html_url,
          title: data.title,
          repo: `${owner}/${repo}`,
          labels,
        },
      };
    } catch (err) {
      const message = (err as Error).message;
      log.error({ owner, repo, err: message }, "Failed to create dispatch issue");
      return { success: false, error: `GitHub issue creation failed: ${message}` };
    }
  },
};
