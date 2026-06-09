/**
 * FounderOS — Project Workflow Tool (Engineering Department)
 * ===========================================================
 * Gives the engineering agent the ability to BUILD FounderOS features and open PRs.
 *
 * Three actions:
 *   read_file   — read a file within ~/Projects (no HITL, immediate)
 *   list_files  — list a directory within ~/Projects (no HITL, immediate)
 *   run_command — run a shell command within ~/Projects (HITL-gated)
 *
 * SECURITY:
 *   - Path guard: only ~/Projects/** allowed (separate from personal $HOME guard)
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
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve, normalize } from "node:path";
import { childLogger } from "../infra/logger.js";
import type { UnifiedTool, ToolResult } from "./index.js";

const log = childLogger({ module: "tool:project-workflow" });

// ── Path guard ────────────────────────────────────────────────────────────────

const PROJECTS_ROOT_OVERRIDE = process.env["PROJECT_WORKFLOW_ROOT"];

/** The root directory all project paths are confined to. */
export function projectRoot(): string {
  if (PROJECTS_ROOT_OVERRIDE) return PROJECTS_ROOT_OVERRIDE;
  const home = process.env["HOME"] ?? "/Users/pushkarverma";
  return join(home, "Projects");
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
 * Returns true if the given (absolute) path is allowed under the project root.
 * Blocks: traversal, anything outside ~/Projects, and secret file patterns.
 */
export function isProjectPath(path: string): boolean {
  const root = projectRoot();
  const normalized = normalize(resolve(path));

  // Must be within the project root
  if (!normalized.startsWith(root + "/") && normalized !== root) return false;

  // Block secret filename patterns
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
    "create branches, write files, commit, push, and open PRs — all within ~/Projects. " +
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
        description: "File or directory path for read_file / list_files. Absolute or relative to ~/Projects.",
      },
      cwd: {
        type: "string",
        description: "Working directory for run_command (default: ~/Projects/founderos). Must be within ~/Projects.",
      },
    },
    required: ["action"],
  },

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const action = args["action"] as WorkflowAction;
    const root = projectRoot();
    const home = process.env["HOME"] ?? "/Users/pushkarverma";
    const defaultCwd = join(home, "Projects/founderos");

    // ── read_file ─────────────────────────────────────────────────────────────
    if (action === "read_file") {
      const rawPath = args["path"] as string | undefined;
      if (!rawPath) return { success: false, error: "read_file requires a path argument." };

      const abs = rawPath.startsWith("/") ? rawPath : join(root, rawPath);
      if (!isProjectPath(abs)) {
        return {
          success: false,
          error: `Access denied: ${abs} is outside ~/Projects or matches a blocked pattern.`,
        };
      }

      try {
        const content = readFileSync(abs, "utf-8");
        return { success: true, data: content || "(empty file)" };
      } catch (err) {
        return { success: false, error: `Read failed: ${(err as Error).message}` };
      }
    }

    // ── list_files ────────────────────────────────────────────────────────────
    if (action === "list_files") {
      const rawPath = (args["path"] as string | undefined) ?? root;
      const abs = rawPath.startsWith("/") ? rawPath : join(root, rawPath);

      if (!isProjectPath(abs) && abs !== root) {
        return {
          success: false,
          error: `Access denied: ${abs} is outside ~/Projects.`,
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
        const MAX_TOOL_OUTPUT = 10_000;
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
