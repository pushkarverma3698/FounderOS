/**
 * Engineering department tools.
 *   github_read      — read-only (no approval)
 *   github_write     — WRITE (HITL-gated)
 *   project_workflow — read = instant; run_command = HITL-gated
 *   claude_code      — WRITE (HITL-gated)
 *   apply_cinematic_preset — read-only scaffold copy (no approval)
 *   deploy_static_site — WRITE (HITL-gated)
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { RunnableConfig } from "@langchain/core/runnables";
import { githubTool } from "../../tools/github.js";
import { projectWorkflowTool, flagDangerousWorkflowCommand } from "../../tools/project-workflow.js";
import { claudeCodeTool, findClaudeBinary } from "../../tools/claude-code.js";
import { applyCinematicPresetTool } from "../../tools/cinematic-preset.js";
import { deployStaticSiteTool } from "../../tools/deploy-static-site.js";
import { childLogger } from "../../infra/logger.js";
import { hitlGate, idemKey } from "./hitl.js";
import { makeRepeatGuard, makeThreadScopedRegistry } from "./repeat-guard.js";
import { toolFailure, isStructuredToolFailure, type ToolFailureStage } from "../tool-result.js";
import { hasBeenAudited, writeAuditEntry, publishDeptEventWithAudit, recordWorkflowRun } from "../../db/queries.js";
import { slugifyWorkflow, workflowSignature } from "../../tools/workflow-catalog.js";
import { TENANT } from "../../core/config.js";
import { sendStatusText } from "../../infra/telegram-send.js";
import { prepareSignal } from "./signals.js";

const log = childLogger({ module: "agent-tools:engineering" });

/**
 * Classify a raw GitHub/Octokit error message into the REAL failing component
 * (rule #22) so the gateway surfaces it loudly and points at its own fix.
 * The launch-day P1/P2 bug: a 401 "Bad credentials" (expired GITHUB_TOKEN)
 * reached the ReAct loop as a plain string and was swallowed → silent NO-REPLY.
 * Pure + unit-tested; never throws.
 */
export function classifyGithubError(message: string): ToolFailureStage {
  const m = message.toLowerCase();
  if (
    m.includes("bad credentials") ||
    m.includes("401") ||
    m.includes("403") ||
    m.includes("forbidden") ||
    m.includes("not accessible by personal access token") ||
    m.includes("requires authentication") ||
    m.includes("token")
  ) {
    return "auth";
  }
  if (
    m.includes("enotfound") ||
    m.includes("etimedout") ||
    m.includes("econnrefused") ||
    m.includes("econnreset") ||
    m.includes("network")
  ) {
    return "network";
  }
  return "external_api";
}

/** Wrap a failed GitHub ToolResult into a stage-tagged, fail-loud envelope. */
function githubFailure(action: string, error: string): string {
  const stage = classifyGithubError(error);
  const hint =
    stage === "auth"
      ? " — rotate GITHUB_TOKEN (expired or missing scope)"
      : stage === "network"
        ? " — GitHub unreachable, retry shortly"
        : "";
  return toolFailure(stage, `GitHub ${action} failed: ${error}${hint}`);
}

// ── Consecutive-failure cap (B5 — GitHub loop-wedge fix) ─────────────────────
//
// Problem: when github_read / github_write hit a 401 / auth error the ReAct
// agent retries the tool indefinitely until GraphRecursionError ("🔁 stuck in
// a loop"). The structured toolFailure envelope alone is not enough — the agent
// treats any tool result as an invitation to try again.
//
// Fix: on the 2nd consecutive structured failure for the same tool within a
// single turn, upgrade the result to a plain terminal message (no envelope
// marker) that explicitly tells the agent to stop. The counter is injected
// so the pure `capConsecutiveToolFailures` helper is fully unit-testable.

/** Consecutive-failure counter for a single turn. Keyed by tool name. */
export type ToolFailureCounter = {
  get(toolName: string): number;
  increment(toolName: string): void;
  reset(toolName: string): void;
};

/** Factory — creates one counter instance per turn (or per test case). */
export function makeToolFailureCounter(): ToolFailureCounter {
  const counts = new Map<string, number>();
  return {
    get(toolName: string): number {
      return counts.get(toolName) ?? 0;
    },
    increment(toolName: string): void {
      counts.set(toolName, (counts.get(toolName) ?? 0) + 1);
    },
    reset(toolName: string): void {
      counts.set(toolName, 0);
    },
  };
}

/**
 * Cap consecutive structured tool failures within a turn (pure, deterministic).
 *
 * - Success result  → resets the counter, returns the result unchanged.
 * - 1st failure     → increments counter to 1, returns the failure as-is
 *                     (the ReAct agent is allowed one retry).
 * - 2nd+ failure    → returns a TERMINAL plain-text message (no envelope
 *                     marker) that names the real failing component (rule #22)
 *                     and instructs the agent to stop retrying.
 */
export function capConsecutiveToolFailures(
  counter: ToolFailureCounter,
  toolName: string,
  result: string,
): string {
  if (!isStructuredToolFailure(result)) {
    // Success path — reset streak and pass through
    counter.reset(toolName);
    return result;
  }

  counter.increment(toolName);
  const streak = counter.get(toolName);

  if (streak >= 2) {
    // Terminal: surface the real error to the founder; tell the agent to stop.
    // We strip the structured marker so the gateway doesn't double-surface and
    // the agent sees a plain instruction, not an envelope it might retry.
    const body = result.replace(/\s*\[\[TOOL_FAILURE[^\]]*\]\]/g, "").trim();
    return (
      `GitHub auth failed — ${body}. ` +
      `Do not retry this tool. Report to the founder: the GITHUB_TOKEN is likely expired or missing the required scope. ` +
      `Stop here and surface this error directly.`
    );
  }

  return result;
}

// Per-THREAD registries (fix 2026-06-30): a single shared counter/guard at
// module scope would leak across every conversation for the life of the
// process (the office graph compiles once — rule #2). Each thread_id now gets
// its own lazily-created counter and repeat-guard, so one thread's call
// history can never block or contaminate another's (rule #20).
// Tests inject their own counter/guard via the pure helpers directly.
const _githubFailureCounters = makeThreadScopedRegistry(makeToolFailureCounter);

// Repeat-call breaker (T04): bounds identical github_read calls even when they
// SUCCEED — the failure cap above only fires on errors. Time-windowed so it
// self-scopes to a turn; a legitimate repeat minutes later is never blocked.
const _githubRepeatGuards = makeThreadScopedRegistry(() => makeRepeatGuard());

function threadIdFrom(config: RunnableConfig | undefined): string | undefined {
  return config?.configurable?.["thread_id"] as string | undefined;
}

// ── Engineering: GitHub read (read-only, NO approval) ─────────────────────────

export const githubRead = tool(
  async ({ action, owner, repo }, config) => {
    const threadId = threadIdFrom(config);
    const repeatGuard = _githubRepeatGuards.get(threadId);
    const failureCounter = _githubFailureCounters.get(threadId);

    // Loop breaker: if the model has already called github_read with this exact
    // input twice, stop hitting the API and force it to answer with what it has.
    // This is the deterministic fix for the GraphRecursionError wedge on a
    // successful-but-repeated list_repos (rule #16 — never trust the model to stop).
    if (repeatGuard.shouldBlock("github_read", { action, owner, repo })) {
      return (
        `You have already called github_read (action="${action}") with these exact ` +
        `arguments and the result is in the conversation above. Do NOT call github_read ` +
        `again — answer the founder now using the data you already retrieved.`
      );
    }
    const res = await githubTool.execute({ action, ...(owner ? { owner } : {}), ...(repo ? { repo } : {}) });
    if (!res.success) {
      return capConsecutiveToolFailures(
        failureCounter,
        "github_read",
        githubFailure(`read (${action})`, res.error ?? "unknown error"),
      );
    }
    return capConsecutiveToolFailures(failureCounter, "github_read", JSON.stringify(res.data, null, 2));
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

    const failureCounter = _githubFailureCounters.get(threadIdFrom(config));
    if (!res.success) {
      return capConsecutiveToolFailures(
        failureCounter,
        "github_write",
        githubFailure(action, res.error ?? "unknown error"),
      );
    }
    const auditGh = await writeAuditEntry({ action: `github_${action}`, idempotency_key: key, payload: { action, owner, repo, title }, tenant_id: TENANT });
    if (!auditGh.written) log.warn({ key, action }, "writeAuditEntry: conflict on github_write");
    return capConsecutiveToolFailures(
      failureCounter,
      "github_write",
      `✅ GitHub ${action} done: ${JSON.stringify(res.data)}`,
    );
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
    // Catalog the workflow (command only — claude_code writes to the VPS
    // workspace, not S3). Best-effort: never fail an already-succeeded run.
    // allow-failopen: workflow cataloging is an index, never a dependency
    await recordWorkflowRun({
      tenant_id: TENANT,
      slug: slugifyWorkflow(task),
      signature: workflowSignature("claude_code", task),
      tool: "claude_code",
      command: task,
      ...(cwd ? { brief: `cwd: ${cwd}` } : {}),
    }).catch((err) => log.warn({ err: String(err) }, "claude_code: workflow catalog write failed (non-fatal)"));
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

// ── Engineering: cinematic preset scaffold (read-only copy) ───────────────────

export const applyCinematicPreset = tool(
  async ({ preset, targetDir, client }) => {
    const res = await applyCinematicPresetTool.execute({
      preset,
      targetDir,
      ...(client ? { client } : {}),
    });
    if (!res.success) return `apply_cinematic_preset failed: ${res.error}`;
    const data = res.data as {
      preset: string;
      targetDir: string;
      sourceDir: string;
      filesCopied: string[];
      bytesCopied: number;
    };
    return (
      `✅ Applied cinematic-web "${data.preset}" preset → ${data.targetDir}\n` +
      `   source: ${data.sourceDir}\n` +
      `   files: ${data.filesCopied.join(", ") || "index.html"} (${data.bytesCopied} bytes)`
    );
  },
  {
    name: "apply_cinematic_preset",
    description: applyCinematicPresetTool.description,
    schema: z.object({
      preset: z.enum(["neon", "glass", "terminal", "minimal"]).describe("cinematic-web preset name"),
      targetDir: z.string().describe("Destination under ~/Projects"),
      client: z.string().optional().nullable().describe("Client name for placeholder copy"),
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
