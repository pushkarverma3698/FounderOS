/**
 * FounderOS v2 — Agent Tools (LangChain-wrapped, HITL-gated)
 * ===========================================================
 * Adapts the real UnifiedTools (src/tools/*) into LangChain `tool()`s that the
 * ReAct sub-agents can call. The KEY fix vs v1: write tools call LangGraph's
 * native `interrupt()` to request the founder's approval, and the SAME tool
 * executes the real action on resume. "Approve → audit log → nothing" is now
 * structurally impossible — the tool IS what runs after approval.
 *
 * Approval contract (read by the Telegram gateway):
 *   interrupt({ kind: "approval", action, title, summary, preview, args })
 *   resume value: "approved" | "rejected"
 *
 * NOTE on interrupt() re-execution semantics:
 *   When interrupt() fires, the tool throws and the graph pauses. On resume the
 *   tool re-runs from the top; interrupt() then RETURNS the resume value. So any
 *   code BEFORE interrupt() runs twice — keep it pure (we only build a summary).
 *   All real side-effects (suppression check, send) happen AFTER interrupt().
 */

import { tool } from "@langchain/core/tools";
import { TENANT } from "../core/config.js";
import { interrupt } from "@langchain/langgraph";
import { z } from "zod";
import { createHash } from "node:crypto";
import { webSearchTool } from "../tools/web-search.js";
import { emailTool } from "../tools/email.js";
import { readEmailsTool } from "../tools/email-reader.js";
import { githubTool } from "../tools/github.js";
import { linkedinPostTool } from "../tools/linkedin.js";
import { isSuppressed } from "../db/queries.js";
import { childLogger } from "../infra/logger.js";
import { validateBrandVoice } from "../infra/brand-validator.js";
import { flagDangerousCommand, personalRoot } from "../infra/path-guard.js";
import {
  readFileSafe,
  listDirSafe,
  writeFileSafe,
  runShellSafe,
  browserAction,
  type BrowserAction,
} from "../tools/personal.js";
import { readCvTool, searchJobsTool } from "../tools/career.js";
import { projectWorkflowTool, flagDangerousWorkflowCommand } from "../tools/project-workflow.js";
import { claudeCodeTool, findClaudeBinary } from "../tools/claude-code.js";
import { recordEventTool as rawRecordEvent } from "../tools/memory.js";

const log = childLogger({ module: "agent-tools" });

/** Single-user tenant for now (column preserved for the future SaaS pivot). */

/** Deterministic idempotency key so the same action never fires twice. */
function idemKey(prefix: string, ...parts: string[]): string {
  const h = createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 16);
  return `${prefix}:${TENANT}:${h}`;
}

/** Approval payload shape surfaced to the Telegram gateway via interrupt(). */
export interface ApprovalRequest {
  kind: "approval";
  action: string;
  title: string;
  summary: string;
  preview: string;
  args: Record<string, unknown>;
}

// ── Research: web search (read-only, NO approval) ─────────────────────────────

export const searchWeb = tool(
  async ({ query, limit }) => {
    const res = await webSearchTool.execute({ query, limit: limit ?? 5 });
    if (!res.success) {
      return `Web search failed: ${res.error ?? "unknown error"}. (Check that FIRECRAWL_API_KEY is set.)`;
    }
    const results = (res.data as Array<{ title: string; url: string; snippet: string }>) ?? [];
    if (results.length === 0) return `No web results found for "${query}".`;
    return results
      .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
      .join("\n\n");
  },
  {
    name: "search_web",
    description:
      "Search the web for current information, news, or company/market research. Returns titles, URLs, and snippets. Read-only — no approval needed.",
    schema: z.object({
      query: z.string().describe("The search query"),
      limit: z.number().optional().describe("Max results (default 5)"),
    }),
  },
);

// ── Comms: send email (WRITE — requires approval) ─────────────────────────────

export const sendEmail = tool(
  async ({ to, subject, body }) => {
    // Brand voice check — runs before interrupt() so the HITL card only shows
    // clean content. If violations found, agent self-corrects and calls again.
    const brandCheck = validateBrandVoice(body, "outreach");
    if (!brandCheck.valid) {
      return `Fix these brand violations before sending:\n${brandCheck.violations.join("\n")}`;
    }

    // Pure summary (may run twice) — request approval.
    const decision = interrupt({
      kind: "approval",
      action: "send_email",
      title: `📧 Send email to ${to}?`,
      summary: `Subject: ${subject}`,
      preview: body,
      args: { to, subject, body },
    } satisfies ApprovalRequest) as string;

    if (decision !== "approved") {
      return `Email to ${to} was NOT sent — the founder rejected it.`;
    }

    // Side-effects only AFTER approval.
    if (await isSuppressed(TENANT, to)) {
      return `BLOCKED: ${to} is on the do-not-contact list. Email not sent.`;
    }

    const res = await emailTool.execute({
      to,
      subject,
      body,
      idempotency_key: idemKey("email", to, subject, body),
      tenant_id: TENANT,
    });

    if (!res.success) return `Email send failed: ${res.error}`;
    const data = res.data as { skipped?: boolean } | undefined;
    if (data?.skipped) return `This exact email was already sent earlier — not re-sent (idempotency).`;
    log.info({ to }, "Email sent via agent");
    return `✅ Email sent to ${to} (subject: "${subject}").`;
  },
  {
    name: "send_email",
    description:
      "Send an email. The founder is asked to APPROVE before it sends (this is required). Provide recipient, a clear subject, and the full body.",
    schema: z.object({
      to: z.string().describe("Recipient email address"),
      subject: z.string().describe("Email subject line"),
      body: z.string().describe("Full email body text"),
    }),
  },
);

// ── Comms: LinkedIn post (WRITE — requires approval) ──────────────────────────

export const linkedinPost = tool(
  async ({ text }) => {
    // Brand voice check — runs before interrupt() so the HITL card only shows
    // clean, brand-compliant content. Violations → agent self-corrects.
    const brandCheck = validateBrandVoice(text, "linkedin");
    if (!brandCheck.valid) {
      return `Fix these brand violations before posting:\n${brandCheck.violations.join("\n")}`;
    }

    const decision = interrupt({
      kind: "approval",
      action: "linkedin_post",
      title: "📣 Publish this LinkedIn post?",
      summary: "New LinkedIn post",
      preview: text,
      args: { text },
    } satisfies ApprovalRequest) as string;

    if (decision !== "approved") {
      return `LinkedIn post was NOT published — the founder rejected it.`;
    }

    const res = await linkedinPostTool.execute({
      text,
      idempotency_key: idemKey("linkedin", text),
      tenant_id: TENANT,
    });

    if (!res.success) return `LinkedIn post failed: ${res.error}`;
    const data = res.data as { skipped?: boolean } | undefined;
    if (data?.skipped) return `This post was already published earlier — not re-posted (idempotency).`;
    return `✅ LinkedIn post published.`;
  },
  {
    name: "linkedin_post",
    description:
      "Publish a post to LinkedIn. The founder is asked to APPROVE before it publishes. Provide the full final post text.",
    schema: z.object({
      text: z.string().describe("The full post text, ready to publish"),
    }),
  },
);

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
      "Read from GitHub (no approval needed). Actions: list_repos (optional owner), get_readme (owner+repo), get_stats.",
    schema: z.object({
      action: z.enum(["list_repos", "get_readme", "get_stats"]),
      owner: z.string().optional(),
      repo: z.string().optional(),
    }),
  },
);

// ── Engineering: GitHub write (WRITE — requires approval) ─────────────────────

export const githubWrite = tool(
  async ({ action, owner, repo, title, body, content }) => {
    const decision = interrupt({
      kind: "approval",
      action: `github_${action}`,
      title: `🔧 GitHub ${action} — proceed?`,
      summary: `${action} ${owner ?? ""}${repo ? "/" + repo : ""}${title ? " · " + title : ""}`.trim(),
      preview: content ?? body ?? title ?? "",
      args: { action, owner, repo, title, body, content },
    } satisfies ApprovalRequest) as string;

    if (decision !== "approved") {
      return `GitHub ${action} was NOT done — the founder rejected it.`;
    }

    const res = await githubTool.execute({
      action,
      ...(owner ? { owner } : {}),
      ...(repo ? { repo } : {}),
      ...(title ? { title } : {}),
      ...(body ? { body } : {}),
      ...(content ? { content } : {}),
    });

    if (!res.success) return `GitHub ${action} failed: ${res.error}`;
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

// ── Comms: read emails (read-only, NO approval) ────────────────────────────────

export const readEmails = tool(
  async ({ query, limit }) => {
    const res = await readEmailsTool.execute({ query, max_results: limit ?? 10 });
    if (!res.success) {
      return `Email read failed: ${res.error ?? "unknown error"}. (Check that COMPOSIO_API_KEY is set.)`;
    }
    return typeof res.data === "string" ? res.data : JSON.stringify(res.data);
  },
  {
    name: "read_emails",
    description:
      "Read emails from Gmail inbox. Use Gmail search syntax: 'is:unread', 'from:alice@example.com', 'subject:invoice'. Read-only — no approval needed.",
    schema: z.object({
      query: z.string().optional().describe("Gmail search query (default: 'in:inbox')"),
      limit: z.number().optional().describe("Max emails to return (default 10)"),
    }),
  },
);

// ── Personal: read a file (read-only, NO approval) ────────────────────────────

export const readFile = tool(
  async ({ path: filePath }) => {
    const r = await readFileSafe(filePath);
    if (!r.ok) return `ERROR: ${r.error}`;
    // Return a clearly labelled block so the agent copies it into the reply verbatim.
    const body = r.content.length ? r.content : "(file is empty)";
    return `FILE CONTENTS of ${filePath}:\n\`\`\`\n${body}\n\`\`\`\nCopy the above content into your reply to the founder.`;
  },
  {
    name: "read_file",
    description:
      `Read a text file on the founder's laptop (under ${personalRoot()}). Read-only — no approval needed. Secret paths (.ssh, .env, keychains, *.pem) are blocked. The tool returns the file contents labelled — relay them verbatim to the founder.`,
    schema: z.object({
      path: z.string().describe("File path, e.g. 'Projects/app/README.md' or '~/Desktop/notes.txt'"),
    }),
  },
);

// ── Personal: list a directory (read-only, NO approval) ───────────────────────

export const listDir = tool(
  async ({ path: dirPath }) => {
    const r = await listDirSafe(dirPath ?? ".");
    if (!r.ok) return `ERROR: ${r.error}`;
    if (!r.entries.length) return `DIRECTORY LISTING of ${dirPath ?? "~"}:\n(empty directory)`;
    // Return a formatted bullet list so the agent includes it verbatim in the reply.
    const bullets = r.entries.map((e) => `- ${e}`).join("\n");
    return `DIRECTORY LISTING of ${dirPath ?? "~"} (${r.entries.length} entries):\n${bullets}\nCopy this listing into your reply to the founder.`;
  },
  {
    name: "list_dir",
    description:
      "List the contents of a directory on the founder's laptop (under the personal root). Read-only — no approval needed. The tool returns a formatted directory listing — relay it verbatim to the founder.",
    schema: z.object({
      path: z.string().optional().describe("Directory path (default: personal root)"),
    }),
  },
);

// ── Personal: write a file (WRITE — requires approval) ────────────────────────

export const writeFile = tool(
  async ({ path: filePath, content }) => {
    const decision = interrupt({
      kind: "approval",
      action: "write_file",
      title: `💾 Write file ${filePath}?`,
      summary: `Write ${content.length} chars to ${filePath}`,
      preview: content.slice(0, 2000),
      args: { path: filePath, content },
    } satisfies ApprovalRequest) as string;

    if (decision !== "approved") {
      return `File ${filePath} was NOT written — the founder rejected it.`;
    }

    const r = await writeFileSafe(filePath, content);
    if (!r.ok) return `Write failed: ${r.error}`;
    log.info({ path: r.path }, "File written via personal agent");
    return `✅ Wrote ${content.length} chars to ${r.path}.`;
  },
  {
    name: "write_file",
    description:
      "Create or overwrite a file on the founder's laptop (under the personal root). The founder is asked to APPROVE before it writes. Provide the path and full file content.",
    schema: z.object({
      path: z.string().describe("File path to write"),
      content: z.string().describe("Full file content"),
    }),
  },
);

// ── Personal: run a shell command / script (WRITE — requires approval) ─────────

export const runShell = tool(
  async ({ command, cwd }) => {
    const dangerous = flagDangerousCommand(command);
    const decision = interrupt({
      kind: "approval",
      action: "run_shell",
      title: `${dangerous ? "⚠️ DANGEROUS " : "🖥️ "}Run shell command?`,
      summary: `${dangerous ? "⚠️ This looks destructive. " : ""}cwd: ${cwd ?? "(personal root)"}`,
      preview: command,
      args: { command, cwd },
    } satisfies ApprovalRequest) as string;

    if (decision !== "approved") {
      return `Command was NOT run — the founder rejected it.`;
    }

    const r = await runShellSafe(command, cwd);
    if (!r.ok) return `Command failed: ${r.error}`;
    log.info({ command }, "Shell command run via personal agent");
    const out = [r.stdout && `stdout:\n${r.stdout}`, r.stderr && `stderr:\n${r.stderr}`]
      .filter(Boolean)
      .join("\n\n");
    return `✅ Command finished.\n${out || "(no output)"}`;
  },
  {
    name: "run_shell",
    description:
      "Run a shell command or script on the founder's laptop, with the working directory confined to the personal root. The founder is asked to APPROVE before it runs (destructive patterns are flagged). Use for builds, scripts, git, file ops.",
    schema: z.object({
      command: z.string().describe("The shell command to run"),
      cwd: z.string().optional().describe("Working directory (default: personal root)"),
    }),
  },
);

// ── Job-Hunt: read CV from personal-rag (read-only, NO approval) ─────────────

export const readCv = tool(
  async ({ query }) => {
    const res = await readCvTool.execute({ query });
    if (!res.success) return `CV read failed: ${res.error}`;
    return typeof res.data === "string" ? res.data : JSON.stringify(res.data);
  },
  {
    name: "read_cv",
    description: readCvTool.description,
    schema: z.object({
      query: z.string().describe(
        "What to look up from the CV/background. E.g. 'LangGraph experience', 'TypeScript projects', 'salary expectations'"
      ),
    }),
  },
);

// ── Job-Hunt: search for job postings (read-only, NO approval) ───────────────

export const searchJobs = tool(
  async ({ query, location }) => {
    const res = await searchJobsTool.execute({ query, ...(location ? { location } : {}) });
    if (!res.success) return `Job search failed: ${res.error}`;
    return typeof res.data === "string" ? res.data : JSON.stringify(res.data);
  },
  {
    name: "search_jobs",
    description: searchJobsTool.description,
    schema: z.object({
      query: z.string().describe("Role + keywords, e.g. 'AI engineer LangGraph TypeScript'"),
      location: z.string().optional().describe("Location, e.g. 'Amsterdam' or 'remote EU'"),
    }),
  },
);

// ── Engineering: project workflow — build + test + commit + PR ────────────────
// The ONE tool that gives engineering autonomous code-build capability.
// read_file and list_files: instant (no HITL).
// run_command: ALWAYS HITL-gated (shows command + cwd before executing).

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
      const dangerous = flagDangerousWorkflowCommand(command);
      const decision = interrupt({
        kind: "approval",
        action: "project_workflow",
        title: `${dangerous ? "⚠️ DANGEROUS " : "🔧 "}Run command in project?`,
        summary: `${dangerous ? "⚠️ Potentially destructive. " : ""}cwd: ${cwd ?? "founderos"}`,
        preview: command,
        args: { action, command, cwd },
      } satisfies ApprovalRequest) as string;

      if (decision !== "approved") {
        return `Command was NOT run — the founder rejected it.`;
      }

      const res = await projectWorkflowTool.execute({ action, command, cwd });
      if (!res.success) return `Command failed: ${res.error}`;
      log.info({ command, cwd }, "project_workflow command executed via engineering agent");
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
// Always requires founder approval before invoking the CLI.
// The HITL card shows the task so the founder knows exactly what prompt is sent.

export const claudeCode = tool(
  async ({ task, cwd }) => {
    // Detect binary before showing the approval card so we fail fast
    const binary = findClaudeBinary();
    if (!binary) {
      return `Claude Code CLI not found. Install with: npm install -g @anthropic-ai/claude-code`;
    }

    const decision = interrupt({
      kind: "approval",
      action: "claude_code",
      title: "Invoke Claude Code CLI?",
      summary: `Run: claude -p "..." in ${cwd ?? "~/Projects/founderos"}`,
      preview: task,
      args: { task, cwd },
    } satisfies ApprovalRequest) as string;

    if (decision !== "approved") {
      return `Claude Code was NOT invoked — the founder rejected it.`;
    }

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

// ── Personal: drive Safari via AppleScript (WRITE — requires approval) ─────────

export const browser = tool(
  async ({ action, url, js }) => {
    const decision = interrupt({
      kind: "approval",
      action: "browser",
      title: `🌐 Browser: ${action}?`,
      summary: action === "open_url" ? `Open ${url}` : action === "run_js" ? "Run JavaScript in Safari" : "Read the current Safari page",
      preview: url ?? js ?? "(current page)",
      args: { action, url, js },
    } satisfies ApprovalRequest) as string;

    if (decision !== "approved") {
      return `Browser action was NOT performed — the founder rejected it.`;
    }

    const r = await browserAction(action as BrowserAction, { ...(url ? { url } : {}), ...(js ? { js } : {}) });
    if (!r.ok) return `Browser action failed: ${r.error}`;
    return r.stdout ? `✅ Done.\n${r.stdout}` : `✅ Done.`;
  },
  {
    name: "browser",
    description:
      "Drive Safari on the founder's laptop. Actions: open_url (needs url), get_page_text (reads the current page), run_js (needs js). The founder is asked to APPROVE before it runs.",
    schema: z.object({
      action: z.enum(["open_url", "get_page_text", "run_js"]),
      url: z.string().optional().describe("URL for open_url"),
      js: z.string().optional().describe("JavaScript for run_js"),
    }),
  },
);

// ── Memory: record_event (WRITE — requires approval) ─────────────────────────

/**
 * HITL wrapper around the raw recordEventTool. The approval card lets the founder
 * review the event before it's committed to episodic_memory.
 */
export const recordEvent = tool(
  async ({ title, summary, tags, event_type, occurred_at }) => {
    const tagsStr = tags.join(", ") || "(none)";
    const decision = interrupt({
      kind: "approval",
      action: "record_event",
      title: `📝 Record event: "${title}"?`,
      summary: `Type: ${event_type} | Tags: ${tagsStr}`,
      preview: summary,
      args: { title, summary, tags, event_type, occurred_at },
    } satisfies ApprovalRequest) as string;

    if (decision !== "approved") {
      return `Event "${title}" was NOT recorded — the founder rejected it.`;
    }

    return rawRecordEvent.invoke({ title, summary, tags, event_type, occurred_at });
  },
  {
    name: "record_event",
    description: rawRecordEvent.description,
    schema: z.object({
      title: z.string().describe("Short, searchable title"),
      summary: z.string().describe("1–3 sentences describing what happened"),
      tags: z.array(z.string()).describe("Keyword tags for retrieval"),
      event_type: z
        .enum(["conversation", "decision", "outcome", "task_completed"])
        .describe("Category of event"),
      occurred_at: z.string().optional().describe("ISO 8601 timestamp. Defaults to now."),
    }),
  },
);
