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
 * Stabilisation hardening (2026-06-03):
 *   - Symlink bypass: after the lexical resolveSafePath check passes, every I/O
 *     operation calls checkSymlink() which realpaths the resolved path and
 *     re-checks through the guard. A symlink inside $HOME that points at ~/.ssh
 *     or /etc is denied before any filesystem call reaches the target.
 *   - OOM protection: readFileSafe stats the file first and, for files larger
 *     than MAX_READ_BYTES, reads only the first MAX_READ_BYTES bytes rather
 *     than buffering the whole file before slicing.
 *
 * Browser actions drive Safari via AppleScript (osascript). buildBrowserScript is
 * pure (unit-tested); browserAction executes it.
 */

import { promises as fs } from "node:fs";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { resolveSafePath, redactSecrets } from "../infra/path-guard.js";

const execAsync = promisify(exec);

const MAX_OUTPUT = 100_000; // cap captured output / file reads (chars)
const MAX_READ_BYTES = MAX_OUTPUT * 4; // worst-case UTF-8: 4 bytes per char
const SHELL_TIMEOUT_MS = parseInt(process.env["SHELL_TIMEOUT_MS"] ?? "120000", 10);

const BINARY_EXTS = new Set([
  ".pdf", ".png", ".jpg", ".jpeg", ".gif", ".docx", ".xlsx",
  ".zip", ".dmg", ".app", ".exe", ".bin", ".ico", ".mp4", ".mp3",
]);

const MAX_SEND_BYTES = 50 * 1024 * 1024; // Telegram bot sendDocument hard limit (50 MB)

export type ReadResult = { ok: true; content: string } | { ok: false; error: string };
export type ListResult = { ok: true; entries: string[] } | { ok: false; error: string };
export type SendableResult =
  | { ok: true; path: string; size: number; name: string }
  | { ok: false; error: string };
export type WriteResult = { ok: true; path: string } | { ok: false; error: string };
export type ShellResult =
  | { ok: true; stdout: string; stderr: string }
  | { ok: false; error: string };

// ── Symlink bypass hardening ──────────────────────────────────────────────────

/**
 * After a lexical resolveSafePath check passes, verify the symlink target (if any)
 * also passes the guard. Returns a denial SafePath if the symlink target is outside
 * the allowed root or on the secret denylist; returns null if safe.
 *
 * Uses lstat + readlink rather than realpath so that broken symlinks (pointing at
 * non-existent paths) are still caught — we care about WHERE a symlink points, not
 * whether the target currently exists.
 *
 * Handles chains of symlinks via a simple hop limit. For each hop we check the
 * resolved link target against resolveSafePath, which is the same guard used
 * lexically before this call. personalRoot() ($HOME) is used for the secret check
 * because that is the canonical deny boundary regardless of any test-overridden root.
 */
/** Returns the denial reason string if a symlink points somewhere forbidden, or null if safe. */
async function checkSymlink(resolvedPath: string): Promise<string | null> {
  const MAX_HOPS = 10;
  let current = resolvedPath;

  for (let hop = 0; hop < MAX_HOPS; hop++) {
    let lstat;
    try {
      lstat = await fs.lstat(current);
    } catch {
      return null; // Path doesn't exist (pre-write or stale) — no symlink concern.
    }
    if (!lstat.isSymbolicLink()) return null; // Not a symlink at this hop.

    // Read the raw link target (may be relative or absolute).
    let linkTarget: string;
    try {
      linkTarget = await fs.readlink(current);
    } catch {
      return null;
    }

    // Resolve to absolute (relative symlinks are relative to the symlink's dir).
    const dir = path.dirname(current);
    const absoluteTarget = path.isAbsolute(linkTarget)
      ? linkTarget
      : path.resolve(dir, linkTarget);

    // Check where the symlink points — uses personalRoot() = $HOME.
    const recheck = resolveSafePath(absoluteTarget);
    if (!recheck.ok) return recheck.reason;

    current = absoluteTarget; // Follow the chain.
  }

  return null; // Exhausted hops without a denial — allow.
}

// ── Tool implementations ──────────────────────────────────────────────────────

/** Read a file inside the personal root. Read-only — no approval needed. */
export async function readFileSafe(input: string, root?: string): Promise<ReadResult> {
  const safe = resolveSafePath(input, root);
  if (!safe.ok) return { ok: false, error: safe.reason };

  // Binary file detection: refuse to read binary formats — use send_file instead.
  const ext = path.extname(safe.path).toLowerCase();
  if (BINARY_EXTS.has(ext)) {
    return {
      ok: false,
      error: `Binary file detected (${ext}). Use send_file to receive "${path.basename(safe.path)}" as a Telegram attachment instead.`,
    };
  }

  // Symlink check: realpath the resolved path and re-verify against the guard.
  const sym = await checkSymlink(safe.path);
  if (sym !== null) return { ok: false, error: sym };

  try {
    // OOM protection: stat first; for large files read only MAX_READ_BYTES bytes.
    const stat = await fs.stat(safe.path);
    let content: string;
    if (stat.size > MAX_READ_BYTES) {
      const fd = await fs.open(safe.path, "r");
      try {
        const buf = Buffer.allocUnsafe(MAX_READ_BYTES);
        const { bytesRead } = await fd.read(buf, 0, MAX_READ_BYTES, 0);
        content = buf.subarray(0, bytesRead).toString("utf8");
      } finally {
        await fd.close();
      }
    } else {
      content = await fs.readFile(safe.path, "utf8");
    }
    // Defense-in-depth: scrub any live-credential tokens before the content can
    // leave the process (e.g. a key pasted into a non-denylisted notes file).
    // The path-guard denylist handles known secret files; this catches the rest.
    const { redacted, count } = redactSecrets(content.slice(0, MAX_OUTPUT));
    if (count > 0) {
      return {
        ok: true,
        content:
          redacted +
          `\n\n⚠️ ${count} secret-looking value(s) were redacted before sending — open the file locally to view them.`,
      };
    }
    return { ok: true, content: redacted };
  } catch (e) {
    return { ok: false, error: `Could not read ${safe.path}: ${(e as Error).message}` };
  }
}

/**
 * Validate that a path points to a real, sendable file inside the personal root.
 * Reuses the SAME path-guard + symlink check as reads, so secret/system paths
 * (.ssh, .env, *.pem, keychains) can NEVER be attached and exfiltrated. Rejects
 * directories, missing files, empty files, and anything over Telegram's 50 MB cap.
 */
export async function resolveSendableFile(input: string, root?: string): Promise<SendableResult> {
  const safe = resolveSafePath(input, root);
  if (!safe.ok) return { ok: false, error: safe.reason };

  const sym = await checkSymlink(safe.path);
  if (sym !== null) return { ok: false, error: sym };

  try {
    const stat = await fs.stat(safe.path);
    if (stat.isDirectory()) {
      return { ok: false, error: `${safe.path} is a directory, not a file. Pick a specific file to send.` };
    }
    if (stat.size === 0) return { ok: false, error: `${safe.path} is empty — nothing to send.` };
    if (stat.size > MAX_SEND_BYTES) {
      return { ok: false, error: `File too large (${(stat.size / 1024 / 1024).toFixed(1)} MB). Telegram's limit is 50 MB.` };
    }
    return { ok: true, path: safe.path, size: stat.size, name: path.basename(safe.path) };
  } catch (e) {
    return { ok: false, error: `Could not access ${safe.path}: ${(e as Error).message}` };
  }
}

/** List a directory inside the personal root. Read-only — no approval needed. */
export async function listDirSafe(input: string, root?: string): Promise<ListResult> {
  const safe = resolveSafePath(input, root);
  if (!safe.ok) return { ok: false, error: safe.reason };

  const sym = await checkSymlink(safe.path);
  if (sym !== null) return { ok: false, error: sym };

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

  // Check the parent directory for symlink bypass (the file itself may not exist yet).
  const parentPath = safe.path.slice(0, safe.path.lastIndexOf("/"));
  if (parentPath) {
    const sym = await checkSymlink(parentPath);
    if (sym !== null) return { ok: false, error: sym };
  }

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

  const sym = await checkSymlink(safeCwd.path);
  if (sym !== null) return { ok: false, error: sym };

  try {
    const { stdout, stderr } = await execAsync(cmd, {
      cwd: safeCwd.path,
      timeout: SHELL_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT,
    });
    return { ok: true, stdout: String(stdout).slice(0, MAX_OUTPUT), stderr: String(stderr).slice(0, MAX_OUTPUT) };
  } catch (e) {
    const err = e as { message: string; stderr?: string; code?: number; killed?: boolean; signal?: string };
    // Distinguish timeout kills (SIGTERM sent by node after the timeout option fires) from
    // regular non-zero exits so the founder gets an actionable message.
    if (err.killed || err.signal === "SIGTERM") {
      return {
        ok: false,
        error: `Command timed out after ${SHELL_TIMEOUT_MS / 1000}s. Try breaking it into smaller steps.`,
      };
    }
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

/**
 * Execute a browser action. Backend is selected by BROWSER_BACKEND env:
 *   "playwright"   — headless Chromium via Playwright (Linux/Ubuntu VPS default)
 *   "applescript"  — Safari via osascript (macOS only)
 *   "auto"         — Playwright on linux, AppleScript on darwin (default when unset)
 *
 * HITL-gated upstream in agent-tools/personal.ts.
 */
export async function browserAction(
  action: BrowserAction,
  opts: { url?: string; js?: string },
): Promise<ShellResult> {
  const backend = process.env["BROWSER_BACKEND"] ?? "auto";
  const usePlaywright =
    backend === "playwright" ||
    (backend === "auto" && process.platform === "linux");

  if (usePlaywright) {
    const { playwrightBrowserAction } = await import("./browser-playwright.js");
    return playwrightBrowserAction(action, opts);
  }

  // AppleScript / Safari (macOS)
  const script = buildBrowserScript(action, opts);
  try {
    const args = script.split("\n").map(line => `-e ${JSON.stringify(line)}`).join(" ");
    const { stdout, stderr } = await execAsync(`osascript ${args}`, {
      timeout: SHELL_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT,
    });
    return { ok: true, stdout: String(stdout).slice(0, MAX_OUTPUT), stderr: String(stderr) };
  } catch (e) {
    return { ok: false, error: `Browser action failed: ${(e as Error).message}` };
  }
}
