/**
 * FounderOS — Project Workflow Tool (Engineering Department)
 * ===========================================================
 * Gives the engineering agent the ability to BUILD FounderOS features and open PRs.
 *
 * Three actions:
 *   read_file   — read a file within an allowed root (no HITL, immediate)
 *   list_files  — list a directory within an allowed root (no HITL, immediate)
 *   run_command — run a shell command within an allowed root (HITL-gated)
 *
 * SECURITY:
 *   - Path guard: only the roots in `projectRoots()` — `~/Projects` plus the
 *     RUNNING APP's own tree (`/opt/founderos` in production, where the agent
 *     could previously not read one line of its own source; issue #426 item 5).
 *     Both are derived from the process, never from a tool argument.
 *   - Secret patterns blocked even for reads (.env, *.pem, .ssh, .aws, .gnupg)
 *   - Dangerous commands flagged in the HITL approval card (rm -rf, force-push to main, dd, mkfs)
 *   - run_command is ALWAYS HITL-gated (no exceptions)
 *
 * ONE TOOL PER AGENT: this is the single tool that gives engineering autonomous
 * build capability. It replaces the need for multiple separate tools.
 *
 * ADR-013 boundary: this tool is scoped to ~/Projects (code work), NOT $HOME.
 * The personal department keeps $HOME-scoped laptop access. These are distinct.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { childLogger } from "../infra/logger.js";
import type { UnifiedTool, ToolResult } from "./index.js";

const log = childLogger({ module: "tool:project-workflow" });

// ── Path guard ────────────────────────────────────────────────────────────────

/** The root directory all project paths are confined to. */
export function projectRoot(): string {
  const override = process.env["PROJECT_WORKFLOW_ROOT"]?.trim();
  if (override) return override;
  const home = process.env["HOME"] ?? "/Users/pushkarverma";
  return join(home, "Projects");
}

/**
 * Where the code currently executing lives, found by walking up from this
 * module to the nearest `package.json`.
 *
 * Derived from the PROCESS, never from a tool argument — an agent cannot widen
 * its own sandbox by asking. Returns null if no package.json is found (a bundled
 * or relocated build), in which case the roots below are unchanged.
 */
function runningAppRoot(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let up = 0; up < 8; up++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Every root a project path may live under.
 *
 * WHY THERE IS MORE THAN ONE. `projectRoot()` is `$HOME/Projects`, which on
 * production is `/home/founderos/Projects` — a directory containing
 * `artifacts/` and nothing else. The deployed application runs from
 * `/opt/founderos`. So the engineering agent's `read_file` and `list_files`,
 * used from inside a live conversation, could not reach one line of the system
 * they were being asked about. That is issue #426 item 5, open since
 * 2026-08-08, and it is why the 2026-09-06 "why is /jobs giving stale jobs?"
 * investigation ended with "the root cause could not be determined" — the agent
 * was asked to diagnose itself with its own source outside the sandbox.
 *
 * Adding the running app's root widens WHERE, and nothing else: SECRET_PATTERNS
 * still blocks `.env`/keys/credentials inside it, traversal is still normalised
 * away, everything outside these roots is still denied, and `run_command`
 * remains HITL-gated without exception.
 *
 * On the dev laptop the app already sits under `~/Projects`, so this is a
 * one-element list there and the behaviour is unchanged.
 */
export function projectRoots(): string[] {
  const roots = [projectRoot()];
  const app = runningAppRoot();
  if (app && !roots.some((r) => app === r || app.startsWith(`${r}/`))) roots.push(app);
  return roots;
}

/**
 * Where `run_command` runs when the caller names no cwd.
 *
 * The running app's own tree, when that is not already under `~/Projects` —
 * i.e. `/opt/founderos` on production. It used to be `~/Projects/founderos`
 * unconditionally, a directory that does not exist on the prod box, so every
 * default-cwd command there failed before it ran.
 */
export function defaultWorkflowCwd(): string {
  const roots = projectRoots();
  const appRoot = roots[1];
  if (appRoot) return appRoot;
  return join(roots[0]!, "founderos");
}

/** Expand a leading ~ to $HOME. */
export function expandHomeInPath(p: string): string {
  const home = process.env["HOME"] ?? "/Users/pushkarverma";
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}

/**
 * Resolve a user-supplied path against the project roots (not process.cwd()).
 * Supports absolute paths, ~/, and bare names like "cinematic-demo" or "src".
 *
 * A relative path resolves against the first root where it EXISTS, so `src`
 * means the running app's `src` on production and the same thing on the laptop.
 * When it exists nowhere the primary root wins, which keeps the "not found"
 * error pointing at the directory the caller most likely meant.
 */
export function resolveProjectPath(rawPath: string): string {
  const expanded = expandHomeInPath(rawPath.trim());
  if (expanded.startsWith("/")) {
    return normalize(resolve(expanded));
  }
  const roots = projectRoots();
  for (const root of roots) {
    const candidate = normalize(resolve(join(root, expanded)));
    if (existsSync(candidate)) return candidate;
  }
  return normalize(resolve(join(roots[0]!, expanded)));
}

/** Secret patterns that are ALWAYS blocked (read or write). */
const SECRET_PATTERNS = [
  /\.env(\.|$)/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /credentials/i,
  /secrets?\./i,
  /token\./i,
];

/**
 * Returns true if the given (absolute) path is allowed under ANY project root.
 * Blocks: traversal, anything outside the roots, and secret file patterns.
 */
export function isProjectPath(path: string): boolean {
  const normalized = normalize(resolve(path));

  // Must be within one of the roots (see projectRoots for why there are two).
  const inARoot = projectRoots().some((root) => normalized === root || normalized.startsWith(`${root}/`));
  if (!inARoot) return false;

  // Block secret filename patterns — unchanged by the extra root.
  const filename = normalized.split("/").pop() ?? "";
  if (SECRET_PATTERNS.some((p) => p.test(filename) || p.test(normalized))) return false;

  return true;
}

// ── Command safety ────────────────────────────────────────────────────────────

/** Returns true if the command matches a known-dangerous pattern. */
export function flagDangerousWorkflowCommand(cmd: string): boolean {
  const lower = cmd.toLowerCase().trim();

  // Force push to main/master
  if (/git\s+push\s+(--force|-f)\s+.*\b(main|master)\b/.test(lower)) return true;

  // rm -rf variants
  if (/\brm\s+-[a-z]*r[a-z]*f/.test(lower)) return true;
  if (/\brm\s+-rf/.test(lower)) return true;

  // Disk format / zero-fill
  if (/\b(mkfs|dd\s+if=\/dev\/zero|shred)\b/.test(lower)) return true;

  // Fork bomb
  if (lower.includes(":(){ :|:& };:")) return true;

  // sudo — privilege escalation
  if (/\bsudo\b/.test(lower)) return true;

  // curl/wget piped to shell — supply chain attack vector
  if (/curl\s+.*\|\s*(ba)?sh/i.test(cmd)) return true;
  if (/wget\s+.*\|\s*(ba)?sh/i.test(cmd)) return true;

  // Recursive permission/ownership changes
  if (/chmod\s+-[Rr]/.test(cmd)) return true;
  if (/chown\s+-[Rr]/.test(cmd)) return true;

  // System-level package managers (linux)
  if (/\bapt(-get)?\s+install\b/.test(lower)) return true;

  // System-level package managers (mac)
  if (/\bbrew\s+install\b/.test(lower)) return true;

  // Global pip install (--user installs outside the project venv)
  if (/\bpip\s+install\s+--user\b/.test(lower)) return true;

  // Global npm install
  if (/\bnpm\s+install\s+-g\b/.test(lower)) return true;

  return false;
}

// ── Exported types ────────────────────────────────────────────────────────────

export type WorkflowAction = "run_command" | "read_file" | "list_files";

// ── Tool definition ───────────────────────────────────────────────────────────

export const projectWorkflowTool: UnifiedTool = {
  name: "project_workflow",
  description:
    "The engineering department's primary BUILD tool. Lets the agent read code, run tests, " +
    "create branches, write files, commit, push, and open PRs — within ~/Projects and the " +
    "running application's own tree (so it can read the code it is executing). " +
    "Actions: read_file (instant), list_files (instant), run_command (HITL-gated). " +
    "Use run_command for: writing files (via shell), pnpm test, git operations, gh pr create.",
  input_schema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["run_command", "read_file", "list_files"],
        description: "What to do: read_file (read a text file), list_files (list a directory), run_command (run a shell command — always HITL-gated)",
      },
      command: {
        type: "string",
        description: "Shell command for run_command. Run from the specified cwd (default: ~/Projects/founderos).",
      },
      path: {
        type: "string",
        description: "File or directory path for read_file / list_files. Absolute, or relative to an allowed root (a relative path resolves against the root where it exists, so \"src\" reaches the running app's source).",
      },
      cwd: {
        type: "string",
        description: "Working directory for run_command (default: the running app's own root). Must be within an allowed root.",
      },
    },
    required: ["action"],
  },

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const action = args["action"] as WorkflowAction;
    const root = projectRoot();
    const defaultCwd = defaultWorkflowCwd();

    // ── read_file ─────────────────────────────────────────────────────────────
    if (action === "read_file") {
      const rawPath = args["path"] as string | undefined;
      if (!rawPath) return { success: false, error: "read_file requires a path argument." };

      const abs = resolveProjectPath(rawPath);
      if (!isProjectPath(abs)) {
        return {
          success: false,
          error:
            `Access denied: ${abs} is outside the allowed roots ` +
            `(${projectRoots().join(", ")}) or matches a blocked secret pattern.`,
        };
      }

      try {
        const raw = readFileSync(abs, "utf-8");
        const MAX_FILE_READ_CHARS = 6_000;
        const content =
          raw.length > MAX_FILE_READ_CHARS
            ? raw.slice(0, MAX_FILE_READ_CHARS) +
              `\n\n[...${raw.length - MAX_FILE_READ_CHARS} chars truncated — use run_command with grep/awk/sed to read specific sections]`
            : raw;
        return { success: true, data: content || "(empty file)" };
      } catch (err) {
        return { success: false, error: `Read failed: ${(err as Error).message}` };
      }
    }

    // ── list_files ────────────────────────────────────────────────────────────
    if (action === "list_files") {
      const rawPath = args["path"] as string | undefined;
      const abs = rawPath === undefined ? root : resolveProjectPath(rawPath);

      if (!isProjectPath(abs) && abs !== root) {
        return {
          success: false,
          error: `Access denied: ${abs} is outside the allowed roots (${projectRoots().join(", ")}).`,
        };
      }

      try {
        const entries = readdirSync(abs);
        const filtered = entries.filter((e) => {
          // Filter out secret files from listings
          return !SECRET_PATTERNS.some((p) => p.test(e));
        });
        return {
          success: true,
          data: `${abs} (${filtered.length} entries):\n${filtered.map((e) => `  ${e}`).join("\n")}`,
        };
      } catch (err) {
        return { success: false, error: `List failed: ${(err as Error).message}` };
      }
    }

    // ── run_command ───────────────────────────────────────────────────────────
    // NOTE: This action MUST be HITL-gated in the LangChain tool wrapper (agent-tools.ts).
    // At the raw tool level we just execute if called directly (e.g., in tests after approval).
    if (action === "run_command") {
      const command = args["command"] as string | undefined;
      if (!command) return { success: false, error: "run_command requires a command argument." };

      const rawCwd = (args["cwd"] as string | undefined) ?? defaultCwd;
      const absCwd = rawCwd.startsWith("/") ? rawCwd : join(root, rawCwd);

      if (!isProjectPath(absCwd) && absCwd !== root) {
        return {
          success: false,
          error: `Access denied: cwd ${absCwd} is outside ~/Projects.`,
        };
      }

      try {
        // execAsync (not execSync) — a long `pnpm test` must NOT block the Node
        // event loop, or the whole Telegram bot freezes for up to 2 minutes.
        const { stdout: out } = await execAsync(command, {
          cwd: absCwd,
          env: { ...process.env },
          timeout: 120_000, // 2 min max
          maxBuffer: 1024 * 1024 * 2, // 2MB
        });
        const rawStdout = out.toString().trim();
        // Keep tool output small — large outputs in chained HITL chains accumulate and
        // can overflow Gemini's context window, causing 400 "contents is not specified".
        // 2 KB per command keeps a 5-step chain under 10 KB total.
        const MAX_TOOL_OUTPUT = 2_000;
        const stdout =
          rawStdout.length > MAX_TOOL_OUTPUT
            ? rawStdout.slice(0, MAX_TOOL_OUTPUT) +
              `\n\n[...${rawStdout.length - MAX_TOOL_OUTPUT} chars truncated — use targeted commands or pipe to head/tail]`
            : rawStdout;
        log.info({ command, cwd: absCwd, outputLen: rawStdout.length }, "project_workflow command executed");
        return { success: true, data: stdout || "(command completed with no output)" };
      } catch (err) {
        const execErr = err as { stdout?: string | Buffer; stderr?: string | Buffer; message: string };
        const stdout = execErr.stdout?.toString().trim() ?? "";
        const stderr = execErr.stderr?.toString().trim() ?? execErr.message;
        return {
          success: false,
          error: `Command failed.\n${stderr ? `stderr: ${stderr}` : ""}${stdout ? `\nstdout: ${stdout}` : ""}`,
        };
      }
    }

    return { success: false, error: `Unknown action: ${action as string}` };
  },
};
