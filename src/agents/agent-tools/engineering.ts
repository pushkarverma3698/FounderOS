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

const log = childLogger({ module: "agent-tools:engineering" });

// ── Engineering: GitHub read (read-only, NO approval) ─────────────────────────

export const githubRead = tool(
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
      owner: z.string().optional(),
      repo: z.string().optional(),
    }),
  },
);

// ── Engineering: GitHub write (WRITE — requires approval) ─────────────────────

export const githubWrite = tool(
  async ({ action, owner, repo, title, body, content }) => {
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
      "Write to GitHub (requires founder approval). Actions: create_issue (owner, repo, title, body), create_repo (title=name, body=description), update_readme (owner, repo, content).",
    schema: z.object({
      action: z.enum(["create_issue", "create_repo", "update_readme"]),
      owner: z.string().optional(),
      repo: z.string().optional(),
      title: z.string().optional(),
      body: z.string().optional(),
      content: z.string().optional(),
    }),
  },
);

// ── Engineering: project workflow — build + test + commit + PR ────────────────
// read_file / list_files: instant (no HITL). run_command: ALWAYS HITL-gated.

export const projectWorkflow = tool(
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
      command: z.string().optional().describe(
        "Shell command for run_command. E.g. 'pnpm test', 'git checkout -b feat/x', 'gh pr create --title ...' "
      ),
      path: z.string().optional().describe("File/dir path for read_file or list_files (within ~/Projects)"),
      cwd: z.string().optional().describe("Working dir for run_command (default: ~/Projects/founderos)"),
    }),
  },
);

// ── Engineering: Claude Code CLI (HITL-gated) ────────────────────────────────

export const claudeCode = tool(
  async ({ task, cwd }) => {
    // Detect binary before showing the approval card so we fail fast
    const binary = findClaudeBinary();
    if (!binary) {
      return `Claude Code CLI not found. Install with: npm install -g @anthropic-ai/claude-code`;
    }

    const rejected = hitlGate({
      action: "claude_code",
      title: "Invoke Claude Code CLI?",
      summary: `Run: claude -p "..." in ${cwd ?? "~/Projects/founderos"}`,
      preview: task,
      args: { task, cwd },
    });
    if (rejected) return rejected;

    const res = await claudeCodeTool.execute({ task, cwd });
    if (!res.success) {
      return `Claude Code failed: ${res.error}`;
    }
    log.info({ task: task.slice(0, 80) }, "claude_code executed via engineering agent");
    return typeof res.data === "string" ? res.data : "Claude Code completed.";
  },
  {
    name: "claude_code",
    description: claudeCodeTool.description,
    schema: z.object({
      task: z.string().describe(
        "The task/prompt to send to the Claude Code CLI. Be specific and self-contained."
      ),
      cwd: z.string().optional().describe(
        "Working directory within ~/Projects (default: ~/Projects/founderos)"
      ),
    }),
  },
);
