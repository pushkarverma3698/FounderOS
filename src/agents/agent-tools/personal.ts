/**
 * Personal department tools (the founder's Mac).
 *   read_file / list_dir — read-only (no approval)
 *   send_file            — OUTBOUND (HITL-gated)
 *   write_file / run_shell / browser — WRITE (HITL-gated)
 *
 * Safety: path-guard confines all paths + shell cwd to $HOME and blocks secret
 * paths (.ssh, .env, *.pem, keychains) even for reads.
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import {
  readFileSafe,
  listDirSafe,
  writeFileSafe,
  runShellSafe,
  browserAction,
  resolveSendableFile,
  type BrowserAction,
} from "../../tools/personal.js";
import { flagDangerousCommand, personalRoot } from "../../infra/path-guard.js";
import { sendDocument } from "../../infra/telegram-send.js";
import { childLogger } from "../../infra/logger.js";
import { hitlGate, idemKey } from "./hitl.js";
import { hasBeenAudited, writeAuditEntry } from "../../db/queries.js";
import { TENANT } from "../../core/config.js";

const log = childLogger({ module: "agent-tools:personal" });

// ── Personal: read a file (read-only, NO approval) ────────────────────────────

export const readFile = tool(
  async ({ path: filePath }) => {
    const r = await readFileSafe(filePath);
    if (!r.ok) return `ERROR: ${r.error}`;
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

// ── Personal: send a laptop file to Telegram (OUTBOUND — requires approval) ───

export const sendFile = tool(
  async ({ path: filePath }) => {
    // Validate BEFORE interrupt() (read-only stat; safe to re-run on resume).
    const r = await resolveSendableFile(filePath);
    if (!r.ok) return `ERROR: ${r.error}`;

    const sizeKb = (r.size / 1024).toFixed(1);
    const rejected = hitlGate({
      action: "send_file",
      title: `📎 Send ${r.name} to your Telegram?`,
      summary: `Attach ${r.name} (${sizeKb} KB) from ${r.path}`,
      preview: r.path,
      args: { path: r.path },
    });
    if (rejected) return rejected;

    // Side effect AFTER approval only (rule #3). Single-tenant → default chat.
    try {
      await sendDocument(r.path, r.name);
    } catch (e) {
      return `Send failed: ${(e as Error).message}`;
    }
    log.info({ path: r.path, name: r.name }, "File sent to Telegram via personal agent");
    return `✅ Sent ${r.name} to your Telegram chat as an attachment.`;
  },
  {
    name: "send_file",
    description:
      "Attach a file from the founder's laptop and send it INTO this Telegram chat as a downloadable document. " +
      "Use when the founder says 'send me [file]', 'attach [file]', 'share [file]', 'send the file'. " +
      "The founder APPROVES before it sends. Secret paths (.ssh, .env, *.pem, keychains) are blocked. " +
      "This actually delivers the file — unlike read_file which only shows its text contents.",
    schema: z.object({
      path: z.string().describe("File path on the laptop, e.g. '~/Desktop/report.pdf' or 'Projects/app/notes.md'"),
    }),
  },
);

// ── Personal: write a file (WRITE — requires approval) ────────────────────────

export const writeFile = tool(
  async ({ path: filePath, content }) => {
    const rejected = hitlGate({
      action: "write_file",
      title: `💾 Write file ${filePath}?`,
      summary: `Write ${content.length} chars to ${filePath}`,
      preview: content.slice(0, 2000),
      args: { path: filePath, content },
    });
    if (rejected) return rejected;

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
    // Idempotency: prevent re-execution on HITL resume loop
    const key = idemKey("shell", cwd ?? "", command);
    if (await hasBeenAudited(key)) {
      return `Already executed: ${command.slice(0, 80)}${command.length > 80 ? "…" : ""} (skipped duplicate)`;
    }

    const dangerous = flagDangerousCommand(command);
    const rejected = hitlGate({
      action: "run_shell",
      title: `${dangerous ? "⚠️ DANGEROUS " : "🖥️ "}Run shell command?`,
      summary: `${dangerous ? "⚠️ This looks destructive. " : ""}cwd: ${cwd ?? "(personal root)"}`,
      preview: command,
      args: { command, cwd },
    });
    if (rejected) return rejected;

    const r = await runShellSafe(command, cwd);
    if (!r.ok) return `Command failed: ${r.error}`;
    log.info({ command }, "Shell command run via personal agent");

    // Record after successful execution
    await writeAuditEntry({ action: "run_shell", idempotency_key: key, payload: { command, cwd }, tenant_id: TENANT });

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

// ── Personal: drive Safari via AppleScript (WRITE — requires approval) ─────────

export const browser = tool(
  async ({ action, url, js }) => {
    const rejected = hitlGate({
      action: "browser",
      title: `🌐 Browser: ${action}?`,
      summary: action === "open_url" ? `Open ${url}` : action === "run_js" ? "Run JavaScript in Safari" : "Read the current Safari page",
      preview: url ?? js ?? "(current page)",
      args: { action, url, js },
    });
    if (rejected) return rejected;

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
