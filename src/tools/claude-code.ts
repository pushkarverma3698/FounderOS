/**
 * FounderOS — Claude Code CLI Tool (Engineering Department)
 * =========================================================
 * Wraps the Claude Code CLI (`claude -p "<task>"`) so the engineering agent
 * can delegate complex AI coding tasks to it via Telegram.
 *
 * Usage: founder says "ask claude code to X" → engineering routes here →
 *        HITL approval card shown → on approve, runs `claude -p "X"` → returns output.
 *
 * SECURITY:
 *   - CWD confined to ~/Projects (reuses isProjectPath from project-workflow)
 *   - Binary path resolved once at import time (or via _binaryOverride for tests)
 *   - Timeout: 120 seconds (same as project-workflow run_command)
 *   - Output capped at 64 KB to avoid flooding Telegram
 *
 * NOTE: This tool is ALWAYS HITL-gated at the LangChain wrapper level in
 * agent-tools.ts. The execute() method runs the real action (after approval).
 *
 * Test seam: pass `_binaryOverride` in args to substitute a different binary
 * path at test time (e.g. /bin/echo, /bin/false, /bin/pwd).
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { childLogger } from "../infra/logger.js";
import { isProjectPath } from "./project-workflow.js";
import type { UnifiedTool, ToolResult } from "./index.js";

const log = childLogger({ module: "tool:claude-code" });

// ── Binary discovery ──────────────────────────────────────────────────────────

/**
 * Candidate paths where the Claude Code CLI might be installed.
 * The CLAUDE_CODE_BIN env var allows override (useful for CI).
 */
const CANDIDATE_PATHS = [
  process.env["CLAUDE_CODE_BIN"],
  "/Users/pushkarverma/.local/bin/claude",
  "/usr/local/bin/claude",
  "/opt/homebrew/bin/claude",
].filter(Boolean) as string[];

/**
 * Returns the first resolvable Claude Code binary path, or null if not found.
 * Exported so tests can assert on it independently.
 */
export function findClaudeBinary(): string | null {
  for (const candidate of CANDIDATE_PATHS) {
    if (existsSync(candidate)) return candidate;
  }
  // Try PATH-based lookup as a last resort
  try {
    const result = execSync("which claude 2>/dev/null", { encoding: "utf-8", timeout: 3_000 });
    const path = result.trim();
    if (path) return path;
  } catch {
    // which failed — binary not on PATH
  }
  return null;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const TIMEOUT_MS = 120_000; // 2 minutes — same as project-workflow run_command
const MAX_OUTPUT_BYTES = 64 * 1024; // 64 KB — prevents flooding Telegram

// ── Tool definition ───────────────────────────────────────────────────────────

export const claudeCodeTool: UnifiedTool = {
  name: "claude_code",
  description:
    "Invoke the Claude Code CLI to execute an AI coding task. Use when the founder " +
    "explicitly asks to 'use claude code' or 'ask claude code' for a specific engineering task. " +
    "Runs `claude -p \"<task>\"` non-interactively and returns the full output. HITL-gated.",

  input_schema: {
    type: "object",
    properties: {
      task: {
        type: "string",
        description: "The task/prompt to send to the Claude Code CLI. Be specific and self-contained.",
      },
      cwd: {
        type: "string",
        description:
          "Working directory for the Claude Code session (default: ~/Projects/founderos). " +
          "Must be within ~/Projects.",
      },
    },
    required: ["task"],
  },

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const task = args["task"] as string | undefined;
    if (!task || task.trim().length === 0) {
      return { success: false, error: "claude_code requires a non-empty task argument." };
    }

    // Test seam: allow tests to substitute a different binary without real claude
    const binaryOverride = args["_binaryOverride"] as string | undefined;

    // Resolve binary
    const binary = binaryOverride ?? findClaudeBinary();
    if (!binary || !existsSync(binary)) {
      return {
        success: false,
        error:
          `Claude Code CLI not found. ` +
          `Install it via: npm install -g @anthropic-ai/claude-code\n` +
          `Or set CLAUDE_CODE_BIN env var to its path.\n` +
          `Checked: ${CANDIDATE_PATHS.join(", ")}`,
      };
    }

    // Resolve CWD
    const home = process.env["HOME"] ?? "/Users/pushkarverma";
    const defaultCwd = join(home, "Projects/founderos");
    const rawCwd = (args["cwd"] as string | undefined) ?? defaultCwd;
    const absCwd = rawCwd.startsWith("/") ? rawCwd : join(home, "Projects", rawCwd);

    if (!isProjectPath(absCwd) && absCwd !== join(home, "Projects")) {
      return {
        success: false,
        error: `Access denied: cwd ${absCwd} is outside ~/Projects. Claude Code must run within the projects directory.`,
      };
    }

    // Build command — use -p (print/non-interactive) flag
    // When binary is overridden (test seam), pass the task as a positional arg so
    // /bin/echo and /bin/pwd work correctly in tests.
    const command = binaryOverride
      ? `"${binary}" "${task.replace(/"/g, '\\"')}"`
      : `"${binary}" -p "${task.replace(/"/g, '\\"')}"`;

    log.info({ task: task.slice(0, 80), cwd: absCwd }, "claude_code invoked");

    try {
      const output = execSync(command, {
        cwd: absCwd,
        env: { ...process.env },
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
      });

      const stdout = output.toString("utf-8").trim();
      log.info({ outputLength: stdout.length }, "claude_code completed");

      return {
        success: true,
        data: stdout || "(Claude Code completed with no output)",
      };
    } catch (err) {
      const execErr = err as {
        stdout?: Buffer;
        stderr?: Buffer;
        message: string;
        code?: string | number;
        signal?: string;
      };

      // Timeout
      if (execErr.signal === "SIGTERM" || execErr.message?.includes("ETIMEDOUT") || execErr.message?.includes("timed out")) {
        return {
          success: false,
          error: `Claude Code timed out after ${TIMEOUT_MS / 1000}s. Try breaking the task into smaller steps.`,
        };
      }

      const stderr = execErr.stderr?.toString("utf-8").trim() ?? "";
      const stdout = execErr.stdout?.toString("utf-8").trim() ?? "";
      const details = [stderr, stdout].filter(Boolean).join("\n").trim() || execErr.message;

      return {
        success: false,
        error: `Claude Code execution failed (exit ${execErr.code ?? "unknown"}):\n${details}`,
      };
    }
  },
};
