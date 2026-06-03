/**
 * FounderOS — Personal Department Tool Implementations
 * ====================================================
 * Raw filesystem / shell / browser operations for the `personal` department.
 * Every path-taking function runs through path-guard (resolveSafePath), so a
 * prompt-injected request can never reach outside the personal root or a secret
 * path. These are the side-effecting primitives; the HITL gating lives in the
 * LangChain wrappers (src/agents/agent-tools.ts) — write/shell/browser only run
 * AFTER founder approval.
 *
 * Browser actions drive Safari via AppleScript (osascript). buildBrowserScript is
 * pure (unit-tested); browserAction executes it.
 */

import { promises as fs } from "node:fs";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { resolveSafePath } from "../infra/path-guard.js";

const execAsync = promisify(exec);

const MAX_OUTPUT = 100_000; // cap captured output / file reads (chars)
const SHELL_TIMEOUT_MS = 60_000;

export type ReadResult = { ok: true; content: string } | { ok: false; error: string };
export type ListResult = { ok: true; entries: string[] } | { ok: false; error: string };
export type WriteResult = { ok: true; path: string } | { ok: false; error: string };
export type ShellResult =
  | { ok: true; stdout: string; stderr: string }
  | { ok: false; error: string };

/** Read a file inside the personal root. Read-only — no approval needed. */
export async function readFileSafe(input: string, root?: string): Promise<ReadResult> {
  const safe = resolveSafePath(input, root);
  if (!safe.ok) return { ok: false, error: safe.reason };
  try {
    const content = await fs.readFile(safe.path, "utf8");
    return { ok: true, content: content.slice(0, MAX_OUTPUT) };
  } catch (e) {
    return { ok: false, error: `Could not read ${safe.path}: ${(e as Error).message}` };
  }
}

/** List a directory inside the personal root. Read-only — no approval needed. */
export async function listDirSafe(input: string, root?: string): Promise<ListResult> {
  const safe = resolveSafePath(input, root);
  if (!safe.ok) return { ok: false, error: safe.reason };
  try {
    const entries = await fs.readdir(safe.path);
    return { ok: true, entries };
  } catch (e) {
    return { ok: false, error: `Could not list ${safe.path}: ${(e as Error).message}` };
  }
}

/** Write a file inside the personal root (creating parents). HITL-gated upstream. */
export async function writeFileSafe(input: string, content: string, root?: string): Promise<WriteResult> {
  const safe = resolveSafePath(input, root);
  if (!safe.ok) return { ok: false, error: safe.reason };
  try {
    const dir = safe.path.slice(0, safe.path.lastIndexOf("/"));
    if (dir) await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(safe.path, content, "utf8");
    return { ok: true, path: safe.path };
  } catch (e) {
    return { ok: false, error: `Could not write ${safe.path}: ${(e as Error).message}` };
  }
}

/** Run a shell command with cwd confined to the personal root. HITL-gated upstream. */
export async function runShellSafe(cmd: string, cwd?: string, root?: string): Promise<ShellResult> {
  const safeCwd = resolveSafePath(cwd ?? ".", root);
  if (!safeCwd.ok) return { ok: false, error: safeCwd.reason };
  try {
    const { stdout, stderr } = await execAsync(cmd, {
      cwd: safeCwd.path,
      timeout: SHELL_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT,
    });
    return { ok: true, stdout: String(stdout).slice(0, MAX_OUTPUT), stderr: String(stderr).slice(0, MAX_OUTPUT) };
  } catch (e) {
    const err = e as { message: string; stderr?: string; code?: number };
    return { ok: false, error: `Command failed (exit ${err.code ?? "?"}): ${err.stderr || err.message}` };
  }
}

// ── Browser (Safari via AppleScript) ──────────────────────────────────────────

export type BrowserAction = "open_url" | "get_page_text" | "run_js";

/** Escape a string for embedding inside an AppleScript double-quoted literal. */
function asEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Pure builder: produce the AppleScript for a browser action (unit-tested). */
export function buildBrowserScript(action: BrowserAction, opts: { url?: string; js?: string }): string {
  switch (action) {
    case "open_url":
      return [
        'tell application "Safari"',
        "  activate",
        `  set URL of front document to "${asEscape(opts.url ?? "")}"`,
        "end tell",
      ].join("\n");
    case "get_page_text":
      return [
        'tell application "Safari"',
        '  do JavaScript "document.body.innerText" in front document',
        "end tell",
      ].join("\n");
    case "run_js":
      return [
        'tell application "Safari"',
        `  do JavaScript "${asEscape(opts.js ?? "")}" in front document`,
        "end tell",
      ].join("\n");
  }
}

/** Execute a browser action against Safari. HITL-gated upstream. */
export async function browserAction(
  action: BrowserAction,
  opts: { url?: string; js?: string },
): Promise<ShellResult> {
  const script = buildBrowserScript(action, opts);
  try {
    const { stdout, stderr } = await execAsync(`osascript -e ${JSON.stringify(script)}`, {
      timeout: SHELL_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT,
    });
    return { ok: true, stdout: String(stdout).slice(0, MAX_OUTPUT), stderr: String(stderr) };
  } catch (e) {
    return { ok: false, error: `Browser action failed: ${(e as Error).message}` };
  }
}
