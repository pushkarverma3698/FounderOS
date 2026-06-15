/**
 * Engineering department tools.
 *   github_read      — read-only (no approval)
 *   github_write     — WRITE (HITL-gated)
 *   project_workflow — read = instant; run_command = HITL-gated
 *   claude_code      — WRITE (HITL-gated)
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { githubTool } from "../../tools/github.js";
import { projectWorkflowTool, flagDangerousWorkflowCommand } from "../../tools/project-workflow.js";
import { claudeCodeTool, findClaudeBinary } from "../../tools/claude-code.js";
import { childLogger } from "../../infra/logger.js";
import { hitlGate, idemKey } from "./hitl.js";
import { hasBeenAudited, writeAuditEntry } from "../../db/queries.js";
import { TENANT } from "../../core/config.js";
import { sendStatusText } from "../../infra/telegram-send.js";
import { registerTool } from "../registry.js";

const log = childLogger({ module: "agent-tools:engineering" });

// ── Engineering: GitHub read (read-only, NO approval) ─────────────────────────

export const githubRead = registerTool(
  tool(
    async ({ action, owner, repo }) => {
      const res = await githubTool.execute({ action, ...(owner ? { owner } : {}), ...(repo ? { repo } : {}) });
      if (!res.success) return `GitHub read failed: ${res.error}`;
      return JSON.stringify(res.data, null, 2);
    },
    {
      name: "github_read",
      description:
        "Read from GitHub (no approval needed). Actions: list_repos (optional owner), get_readme (owner+repo), get_stats, " +
        "list_issues (owner+repo → open issues), list_branches (owner+repo → branches), list_commits (owner+repo → recent commits). " +
        "For FounderOS queries use owner='pushkarverma3698' repo='FounderOS'.",
      schema: z.object({
        action: z.enum(["list_repos", "get_readme", "get_stats", "list_issues", "list_branches", "list_commits"]),
        owner: z.string().optional().nullable(),
        repo: z.string().optional().nullable(),
      }),
    },
  ),
  {
    departments: ["engineering"],
    subagents: ["coder", "qa"],
    hitlGated: false,
    promptDescription: "read GitHub (list_repos, get_readme, get_stats, list_issues, list_branches, list_commits). No approval needed.\n    Use list_issues for \"show open issues\", list_branches for \"show branches\", list_commits for \"show git log\".\n    Always pass owner=\"pushkarverma3698\" and repo=\"FounderOS\" for FounderOS-related queries.",
  }
);

// ── Engineering: GitHub write (WRITE — requires approval) ─────────────────────

/**
 * Per-action required fields for github_write. Returns the names of fields that
 * are required for the given action but were not supplied. Pure + unit-tested so
 * an incomplete tool call is rejected with a precise, correctable message rather
 * than falling through to a vague GitHub 4xx the model then hallucinates around.
 */
export function missingGithubWriteFields(
  action: string,
  fields: { owner?: string | null; repo?: string | null; title?: string | null; content?: string | null },
): string[] {
  const requiredByAction: Record<string, string[]> = {
    create_issue: ["owner", "repo", "title"],
    create_repo: ["title"],
    update_readme: ["owner", "repo", "content"],
  };
  const required = requiredByAction[action] ?? [];
  return required.filter((field) => !(fields as Record<string, unknown>)[field]);
}

export const githubWrite = registerTool(
  tool(
    async ({ action, owner, repo, title, body, content }) => {
      // Structured-input guard: a github_write call missing fields its action needs
      // is surfaced to the model as a precise, correctable error — never sent to the
      // GitHub API to fail opaquely (which previously produced confused retries).
      const missing = missingGithubWriteFields(action, { owner, repo, title, content });
      if (missing.length > 0) {
        return `github_${action} needs these fields: ${missing.join(", ")}. Re-call github_write with all of them.`;
      }

      // Idempotency: prevent duplicate GitHub writes on HITL resume loop
      const key = idemKey("github", action, owner ?? "", repo ?? "", title ?? "", body ?? "");
      if (await hasBeenAudited(key)) {
        return `Already performed: github_${action}${repo ? " on " + repo : ""}${title ? " · " + title : ""} (skipped duplicate)`;
      }

      const rejected = hitlGate({
        action: `github_${action}`,
        title: `🔧 GitHub ${action} — proceed?`,
        summary: `${action} ${owner ?? ""}${repo ? "/" + repo : ""}${title ? " · " + title : ""}`.trim(),
        preview: content ?? body ?? title ?? "",
        args: { action, owner, repo, title, body, content },
      });
      if (rejected) return rejected;

      const res = await githubTool.execute({
        action,
        ...(owner ? { owner } : {}),
        ...(repo ? { repo } : {}),
        ...(title ? { title } : {}),
        ...(body ? { body } : {}),
        ...(content ? { content } : {}),
      });

      if (!res.success) return `GitHub ${action} failed: ${res.error}`;
      await writeAuditEntry({ action: `github_${action}`, idempotency_key: key, payload: { action, owner, repo, title }, tenant_id: TENANT });
      return `✅ GitHub ${action} done: ${JSON.stringify(res.data)}`;
    },
    {
      name: "github_write",
      description:
        "Write to GitHub (requires founder approval). Provide ALL fields the chosen action needs. " +
        "Actions: create_issue (needs owner, repo, title; optional body), " +
        "create_repo (needs title=repo name; optional body=description), " +
        "update_readme (needs owner, repo, content).",
      schema: z.object({
        action: z.enum(["create_issue", "create_repo", "update_readme"]),
        owner: z.string().optional().nullable().describe("Repo owner / GitHub username. Required for create_issue and update_readme."),
        repo: z.string().optional().nullable().describe("Repository name. Required for create_issue and update_readme."),
        title: z.string().optional().nullable().describe("Issue title, or the new repo's name for create_repo. Required for create_issue and create_repo."),
        body: z.string().optional().nullable().describe("Issue body, or repo description for create_repo. Optional."),
        content: z.string().optional().nullable().describe("Full README markdown. Required for update_readme."),
      }),
    },
  ),
  {
    departments: ["engineering"],
    subagents: ["devops"],
    hitlGated: true,
    promptDescription: "quick single GitHub writes (create issue/repo, update README). HITL-gated.",
  }
);

// ── Engineering: project workflow — build + test + commit + PR ────────────────
// read_file / list_files: instant (no HITL). run_command: ALWAYS HITL-gated.

export const projectWorkflow = registerTool(
  tool(
    async ({ action, command, path: filePath, cwd }) => {
      // Read actions: instant, no approval
      if (action === "read_file" || action === "list_files") {
        const res = await projectWorkflowTool.execute({ action, path: filePath });
        if (!res.success) return `project_workflow (${action}) failed: ${res.error}`;
        return typeof res.data === "string" ? res.data : JSON.stringify(res.data);
      }

      // run_command: ALWAYS HITL-gated
      if (action === "run_command") {
        if (!command) return "run_command requires a command argument.";

        // Idempotency: prevent re-running commands on HITL resume loop
        const key = idemKey("project_cmd", cwd ?? "", command);
        if (await hasBeenAudited(key)) {
          return `Already executed: ${command.slice(0, 80)}${command.length > 80 ? "…" : ""} (skipped duplicate)`;
        }

        const dangerous = flagDangerousWorkflowCommand(command);
        const rejected = hitlGate({
          action: "project_workflow",
          title: `${dangerous ? "⚠️ DANGEROUS " : "🔧 "}Run command in project?`,
          summary: `${dangerous ? "⚠️ Potentially destructive. " : ""}cwd: ${cwd ?? "founderos"}`,
          preview: command,
          args: { action, command, cwd },
        });
        if (rejected) return rejected;

        const res = await projectWorkflowTool.execute({ action, command, cwd });
        if (!res.success) return `Command failed: ${res.error}`;
        log.info({ command, cwd }, "project_workflow command executed via engineering agent");
        await writeAuditEntry({ action: "project_workflow_cmd", idempotency_key: key, payload: { command, cwd }, tenant_id: TENANT });
        return typeof res.data === "string" ? res.data : "✅ Command completed.";
      }

      return `Unknown action: ${action as string}`;
    },
    {
      name: "project_workflow",
      description: projectWorkflowTool.description,
      schema: z.object({
        action: z.enum(["run_command", "read_file", "list_files"]).describe(
          "read_file / list_files: instant. run_command: always requires founder approval."
        ),
        command: z.string().optional().nullable().describe(
          "Shell command for run_command. E.g. 'pnpm test', 'git checkout -b feat/x', 'gh pr create --title ...' "
        ),
        path: z.string().optional().nullable().describe("File/dir path for read_file or list_files (within ~/Projects)"),
        cwd: z.string().optional().nullable().describe("Working dir for run_command (default: ~/Projects/founderos)"),
      }),
    },
  ),
  {
    departments: ["engineering"],
    subagents: ["devops"],
    hitlGated: true,
    promptDescription: "READ + QUICK STATUS ONLY:\n    read_file / list_files → read code files in ~/Projects (no approval)\n    run_command            → short read-only commands like git status, git log, git branch -vv,\n                             grep/ripgrep searches (ALWAYS requires founder approval)\n    NEVER use run_command to write files (no cat/heredoc/echo/tee into files), create branches,\n    commit, push, or scaffold projects — that is claude_code's job. Hand-rolled shell builds\n    produced broken files and polluted repos before; this rule is permanent.",
  }
);

// ── Engineering: Claude Code CLI (HITL-gated) ────────────────────────────────

export const claudeCode = registerTool(
  tool(
    async ({ task, cwd }) => {
      // Detect binary before showing the approval card so we fail fast
      const binary = findClaudeBinary();
      if (!binary) {
        return `Claude Code CLI not found. Install with: npm install -g @anthropic-ai/claude-code`;
      }

      // Idempotency: a HITL resume replay must not launch a second 15-minute run
      const key = idemKey("claude_code", cwd ?? "", task);
      if (await hasBeenAudited(key)) {
        return `Already executed this exact task (skipped duplicate run).`;
      }

      const rejected = hitlGate({
        action: "claude_code",
        title: "🤖 Run this task with Claude Code?",
        summary: `One approval covers the whole task. Workspace: ${cwd ?? "~/Projects/agent-workspace"}`,
        preview: task,
        args: { task, cwd },
      });
      if (rejected) return rejected;

      const res = await claudeCodeTool.execute({
        task,
        cwd,
        _onProgress: (line: string) => void sendStatusText(`⏳ ${line}`),
      });
      if (!res.success) {
        return `Claude Code failed: ${res.error}`;
      }
      await writeAuditEntry({ action: "claude_code", idempotency_key: key, payload: { task: task.slice(0, 400), cwd }, tenant_id: TENANT });
      log.info({ task: task.slice(0, 80) }, "claude_code executed via engineering agent");
      return typeof res.data === "string" ? res.data : "Claude Code completed.";
    },
    {
      name: "claude_code",
      description: claudeCodeTool.description,
      schema: z.object({
        task: z.string().describe(
          "COMPLETE self-contained task brief: goal, target location, verification steps, " +
          "and where to push/deliver the result. The whole engineering task goes in here at once."
        ),
        cwd: z.string().optional().nullable().describe(
          "Working directory within ~/Projects (default: ~/Projects/agent-workspace). The FounderOS repo is not allowed."
        ),
      }),
    },
  ),
  {
    departments: ["engineering"],
    subagents: ["coder", "qa"],
    hitlGated: true,
    promptDescription: "THE PRIMARY EXECUTOR. Any multi-step engineering task — build a project,\n    create + push a repo, scaffold an app, fix a bug across files, run tests and iterate — goes to\n    claude_code as ONE complete self-contained brief. It is a full coding agent with file tools,\n    shell, git, and gh; it verifies its own work. One founder approval covers the entire task.\n    Write the brief like a ticket: goal, where the result lives (e.g. \"new repo\n    pushkarverma3698/<name>, cloned at ~/Projects/<name>\"), how to verify, what to report back.",
    notes: "a full Claude Code coding agent (files, shell, git, gh) in an isolated workspace — engineering's primary executor for any build/code/repo task.",
  }
);
