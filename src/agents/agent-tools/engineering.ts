/**
 * Engineering department tools.
 *   github_read      — read-only (no approval)
 *   github_write     — WRITE (HITL-gated)
 *   project_workflow — read = instant; run_command = HITL-gated
 *   claude_code      — WRITE (HITL-gated)
 *   deploy_static_site — WRITE (HITL-gated)
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { githubTool } from "../../tools/github.js";
import { projectWorkflowTool, flagDangerousWorkflowCommand } from "../../tools/project-workflow.js";
import { claudeCodeTool, findClaudeBinary } from "../../tools/claude-code.js";
import { deployStaticSiteTool } from "../../tools/deploy-static-site.js";
import { childLogger } from "../../infra/logger.js";
import { hitlGate, idemKey } from "./hitl.js";
import { toolFailure } from "../tool-result.js";
import { hasBeenAudited, writeAuditEntry, publishDeptEventWithAudit } from "../../db/queries.js";
import { TENANT } from "../../core/config.js";
import { sendStatusText } from "../../infra/telegram-send.js";
import { prepareSignal } from "./signals.js";

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
      owner: z.string().optional().nullable(),
      repo: z.string().optional().nullable(),
    }),
  },
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

export const githubWrite = tool(
  async ({ action, owner, repo, title, body, content }, config) => {
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

    const rejected = await hitlGate({
      action: `github_${action}`,
      title: `🔧 GitHub ${action} — proceed?`,
      summary: `${action} ${owner ?? ""}${repo ? "/" + repo : ""}${title ? " · " + title : ""}`.trim(),
      preview: content ?? body ?? title ?? "",
      args: { action, owner, repo, title, body, content },
    }, config);
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
);

// ── Engineering: project workflow — build + test + commit + PR ────────────────
// read_file / list_files: instant (no HITL). run_command: ALWAYS HITL-gated.

export const projectWorkflow = tool(
  async ({ action, command, path: filePath, cwd }, config) => {
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
      const rejected = await hitlGate({
        action: "project_workflow",
        title: `${dangerous ? "⚠️ DANGEROUS " : "🔧 "}Run command in project?`,
        summary: `${dangerous ? "⚠️ Potentially destructive. " : ""}cwd: ${cwd ?? "founderos"}`,
        preview: command,
        args: { action, command, cwd },
      }, config);
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
);

// ── Engineering: Claude Code CLI (HITL-gated) ────────────────────────────────

export const claudeCode = tool(
  async ({ task, cwd }, config) => {
    // Idempotency: a HITL resume replay must not launch a second 15-minute run
    const key = idemKey("claude_code", cwd ?? "", task);
    if (await hasBeenAudited(key)) {
      return `Already executed this exact task (skipped duplicate run).`;
    }

    const rejected = await hitlGate({
      action: "claude_code",
      title: "🤖 Run this task with Claude Code?",
      summary: `One approval covers the whole task. Workspace: ${cwd ?? "~/Projects/agent-workspace"}`,
      preview: task,
      args: { task, cwd },
    }, config);
    if (rejected) return rejected;

    const binary = findClaudeBinary();
    if (!binary) {
      const fail = toolFailure(
        "auth",
        "Claude Code CLI not installed on this host. Install with: npm install -g @anthropic-ai/claude-code — then retry.",
      );
      // Audit so HITL resume + model retries cannot re-enter the same brief.
      await writeAuditEntry({
        action: "claude_code",
        idempotency_key: key,
        payload: { task: task.slice(0, 400), cwd, failed: "no_binary" },
        tenant_id: TENANT,
      });
      return fail;
    }

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
);

// ── Engineering: static site deploy (HITL-gated) ─────────────────────────────

export const deployStaticSite = tool(
  async ({ slug, sourcePath, client, presetUsed }, config) => {
    const key = idemKey("deploy_static_site", slug, sourcePath);
    if (await hasBeenAudited(key)) {
      return `Already deployed ${slug} from this source (skipped duplicate).`;
    }

    const rejected = await hitlGate({
      action: "deploy_static_site",
      title: "🌐 Deploy static site to public URL?",
      summary: `Slug: ${slug} · Source: ${sourcePath}`,
      preview: `Deploys to /clients/${slug}/ (or /showcase-1/) and returns the public URL.`,
      args: { slug, sourcePath, client, presetUsed },
    }, config);
    if (rejected) return rejected;

    const res = await deployStaticSiteTool.execute({
      slug,
      sourcePath,
      ...(client ? { client } : {}),
      ...(presetUsed ? { presetUsed } : {}),
    });
    if (!res.success) return `Deploy failed: ${res.error}`;

    const data = res.data as {
      publicUrl: string;
      deployPath: string;
      deployMode: string;
      bytesCopied: number;
    };

    await writeAuditEntry({
      action: "deploy_static_site",
      idempotency_key: key,
      payload: { slug, sourcePath, publicUrl: data.publicUrl, deployPath: data.deployPath },
      tenant_id: TENANT,
    });

    const clientName = client ?? slug;
    const signalPrepared = prepareSignal(
      "site_deployed",
      {
        client: clientName,
        siteUrl: data.publicUrl,
        ...(presetUsed ? { presetUsed } : {}),
      },
      { fromDept: "engineering" },
    );
    let signalNote = "";
    if (signalPrepared.ok) {
      const signalIdem = idemKey("signal_published", "site_deployed", slug, data.publicUrl);
      if (!(await hasBeenAudited(signalIdem))) {
        await publishDeptEventWithAudit(
          { tenant_id: TENANT, ...signalPrepared.signal, consumed: false },
          {
            tenant_id: TENANT,
            action: "signal_published",
            idempotency_key: signalIdem,
            payload: {
              event_type: "site_deployed",
              to_dept: signalPrepared.signal.to_dept,
              from_dept: "engineering",
              slug,
            },
          },
        );
        signalNote = " · site_deployed signal recorded for sales";
      }
    }

    log.info({ slug, publicUrl: data.publicUrl }, "deploy_static_site executed");
    return (
      `✅ Site deployed (${data.deployMode}): ${data.publicUrl}\n` +
      `   path: ${data.deployPath} (${data.bytesCopied} bytes)${signalNote}`
    );
  },
  {
    name: "deploy_static_site",
    description: deployStaticSiteTool.description,
    schema: z.object({
      slug: z.string().describe("URL-safe client slug (e.g. langfuse, showcase-1)"),
      sourcePath: z.string().describe("Path to index.html or static directory under ~/Projects"),
      client: z.string().optional().nullable().describe("Client name for site_deployed signal"),
      presetUsed: z.string().optional().nullable().describe("cinematic-web preset (neon, glass, etc.)"),
    }),
  },
);
