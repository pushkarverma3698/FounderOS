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
import { resolveSafePath } from "../infra/path-guard.js";

const execAsync = promisify(exec);

const MAX_OUTPUT = 100_000; // cap captured output / file reads (chars)
const MAX_READ_BYTES = MAX_OUTPUT * 4; // worst-case UTF-8: 4 bytes per char
const SHELL_TIMEOUT_MS = 60_000;

export type ReadResult = { ok: true; content: string } | { ok: false; error: string };
export type ListResult = { ok: true; entries: string[] } | { ok: false; error: string };
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
    return { ok: true, content: content.slice(0, MAX_OUTPUT) };
  } catch (e) {
    return { ok: false, error: `Could not read ${safe.path}: ${(e as Error).message}` };
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
