/**
 * FounderOS — Claude Code Executor (Engineering Department)
 * ==========================================================
 * The PRIMARY task executor for multi-step coding/build/repo work. Wraps the
 * Claude Code CLI headless (`claude -p`) so a whole task — "build a website,
 * create a repo, push it" — runs inside a real agent harness (strong model,
 * file tools, verification loop) instead of Gemini improvising one-shot shell
 * strings.
 *
 * Flow: founder asks for an engineering task → ONE HITL approval card (the
 * task brief) → claude -p runs in an isolated workspace → progress streamed
 * to Telegram → final result returned to the office.
 *
 * SECURITY / RELIABILITY:
 *   - CWD confined to ~/Projects, and the bot's OWN repo (~/Projects/founderos)
 *     is HARD-BLOCKED — the agent must never git-checkout/commit the live
 *     process's working tree (this caused real production damage on 2026-06-09).
 *   - Default workspace: ~/Projects/agent-workspace (created on demand).
 *   - Async spawn — never blocks the bot's event loop (the old execSync froze
 *     long polling for the entire run).
 *   - Timeout: 15 minutes (real coding tasks need it; the old 120s killed
 *     everything non-trivial).
 *   - ANTHROPIC_* env vars are stripped from the child so the CLI uses its own
 *     stored login instead of the bot's critic API key (root cause of the
 *     "Claude Code is not logged in" failure).
 *   - Permissions: --permission-mode acceptEdits + explicit --allowedTools.
 *     The founder's upfront HITL approval is the authorization boundary.
 *   - stream-json output parsed line-by-line; assistant progress is forwarded
 *     to Telegram via the api-only sender (no gateway import, no 409).
 */

import { spawn, execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import { createInterface } from "node:readline";
import { childLogger } from "../infra/logger.js";
import { isProjectPath } from "./project-workflow.js";
import type { UnifiedTool, ToolResult } from "./index.js";

const log = childLogger({ module: "tool:claude-code" });

// ── Binary discovery ──────────────────────────────────────────────────────────

const CANDIDATE_PATHS = [
  process.env["CLAUDE_CODE_BIN"],
  join(process.env["HOME"] ?? "/Users/pushkarverma", ".local/bin/claude"),
  "/usr/local/bin/claude",
  "/opt/homebrew/bin/claude",
].filter(Boolean) as string[];

/** Returns the first resolvable Claude Code binary path, or null if not found. */
export function findClaudeBinary(): string | null {
  for (const candidate of CANDIDATE_PATHS) {
    if (existsSync(candidate)) return candidate;
  }
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

export const TIMEOUT_MS = 15 * 60_000; // 15 minutes — real coding tasks need it
const MAX_RESULT_CHARS = 16_000; // final answer cap (Telegram-friendly)
const PROGRESS_MIN_INTERVAL_MS = 20_000; // at most one progress ping per 20s

/** Tools the headless session may use without interactive prompts. */
const ALLOWED_TOOLS = "Bash Edit Write Read Glob Grep WebFetch WebSearch NotebookEdit";

// ── Workspace policy ──────────────────────────────────────────────────────────

function home(): string {
  return process.env["HOME"] ?? "/Users/pushkarverma";
}

/** The bot's own repo — git/file mutations here from an agent are forbidden. */
export function founderosRepoPath(): string {
  return join(home(), "Projects/founderos");
}

/** Default isolated workspace for agent tasks. Created on demand. */
export function defaultWorkspace(): string {
  return join(home(), "Projects/agent-workspace");
}

/**
 * Validate and resolve the working directory for a Claude Code run.
 * Returns { ok: true, cwd } or { ok: false, error }.
 */
export function resolveExecutorCwd(rawCwd?: string | null): { ok: true; cwd: string } | { ok: false; error: string } {
  const target = rawCwd && rawCwd.trim().length > 0
    ? (rawCwd.startsWith("/") ? rawCwd : rawCwd.startsWith("~") ? rawCwd.replace("~", home()) : join(home(), "Projects", rawCwd))
    : defaultWorkspace();
  const abs = normalize(resolve(target));

  const selfRepo = founderosRepoPath();
  if (abs === selfRepo || abs.startsWith(selfRepo + "/")) {
    return {
      ok: false,
      error:
        "Refused: Claude Code may not run inside the FounderOS repo — the bot must never modify its own " +
        "running code (this corrupted the live process before). FounderOS changes are made by the founder " +
        "directly. Use a different project under ~/Projects, or omit cwd for the agent workspace.",
    };
  }

  if (!isProjectPath(abs) && abs !== join(home(), "Projects")) {
    return { ok: false, error: `Access denied: cwd ${abs} is outside ~/Projects.` };
  }

  if (!existsSync(abs)) {
    mkdirSync(abs, { recursive: true });
    log.info({ cwd: abs }, "Created executor workspace directory");
  }
  return { ok: true, cwd: abs };
}

// ── stream-json parsing ───────────────────────────────────────────────────────

interface StreamEvent {
  type?: string;
  subtype?: string;
  result?: string;
  is_error?: boolean;
  message?: { content?: Array<{ type?: string; text?: string; name?: string }> };
}

/**
 * Map a raw Claude Code tool name to a plain-English progress phrase the founder
 * actually understands. Without this, Telegram showed jargon like "⚙️ Write…"
 * and "⚙️ Bash…" — the internal tool names — so the founder couldn't tell what
 * the agent was doing. Keep these warm and human, not technical.
 */
const TOOL_PROGRESS_PHRASES: Record<string, string> = {
  Write: "✍️ Writing a file",
  Edit: "✏️ Editing the code",
  MultiEdit: "✏️ Editing the code",
  Read: "📖 Reading the files",
  Bash: "▶️ Running a command",
  Glob: "🔎 Finding files",
  Grep: "🔎 Searching the code",
  WebFetch: "🌐 Reading a web page",
  WebSearch: "🌐 Searching the web",
  NotebookEdit: "📓 Editing a notebook",
  TodoWrite: "🗂 Planning the steps",
};

/** Humanise a tool name; unknown tools fall back to a generic working phrase. */
export function humanizeToolProgress(toolName: string): string {
  return TOOL_PROGRESS_PHRASES[toolName] ?? "🛠 Working on it";
}

/** Extract a short human-readable progress line from a stream-json event, or null. */
export function progressLineFromEvent(raw: string): string | null {
  let evt: StreamEvent;
  try {
    evt = JSON.parse(raw) as StreamEvent;
  } catch {
    return null;
  }
  if (evt.type !== "assistant" || !evt.message?.content) return null;
  for (const part of evt.message.content) {
    if (part.type === "text" && part.text && part.text.trim().length > 0) {
      const line = part.text.trim().split("\n")[0]!;
      return line.length > 200 ? line.slice(0, 200) + "…" : line;
    }
    if (part.type === "tool_use" && part.name) {
      return `${humanizeToolProgress(part.name)}…`;
    }
  }
  return null;
}

/**
 * Frame the executor's raw output into the deterministic, founder-facing message.
 *
 * This is the SINGLE source of truth for how a completed engineering task reads on
 * Telegram. It is sent DIRECTLY to the founder (bypassing the LLM relay layers) so
 * the result can never be mangled, summarised away, or dumped context-free by the
 * engineering ReAct agent or the supervisor (Telegram-UX fix 2026-06-12). Pure +
 * unit-tested: leads with a clear done-line naming the workspace, then the output
 * verbatim (code blocks intact).
 */
export function frameExecutorResult(opts: { cwd: string; output: string }): string {
  const body = opts.output.trim().length > 0 ? opts.output.trim() : "(no output produced)";
  return `✅ Done — finished in ${opts.cwd}.\n\n${body}`;
}

/** Extract the final result text from a stream-json "result" event, or null. */
export function resultFromEvent(raw: string): { text: string; isError: boolean } | null {
  let evt: StreamEvent;
  try {
    evt = JSON.parse(raw) as StreamEvent;
  } catch {
    return null;
  }
  if (evt.type !== "result") return null;
  return { text: evt.result ?? "(no result text)", isError: evt.is_error === true };
}

/**
 * Build the child environment: inherit everything EXCEPT Anthropic credentials.
 *
 * Auth strategy (in priority order):
 *   1. CLAUDE_EXECUTOR_API_KEY in .env → passed to child as ANTHROPIC_API_KEY.
 *      Use this when you want API-key auth for the Claude Code executor without
 *      exposing the bot's own critic key to the child process.
 *   2. No CLAUDE_EXECUTOR_API_KEY → ANTHROPIC_* stripped from child env so the
 *      CLI uses its own stored credentials (OAuth or `claude config set apiKey`).
 *
 * CLAUDE_* and CLAUDECODE vars are always stripped: they are SDK/session vars (e.g.
 * CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH) that make a child CLI expect host-injected
 * auth and report "Not logged in" instead of reading its own stored credentials.
 */
export function buildExecutorEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const executorApiKey = base["CLAUDE_EXECUTOR_API_KEY"];
  const executorBaseUrl = base["CLAUDE_EXECUTOR_BASE_URL"];
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (k.startsWith("ANTHROPIC_") || k.startsWith("CLAUDE") || k === "CLAUDECODE") continue;
    env[k] = v;
  }
  if (executorApiKey) {
    env["ANTHROPIC_API_KEY"] = executorApiKey;
  }
  if (executorBaseUrl) {
    env["ANTHROPIC_BASE_URL"] = executorBaseUrl;
  }
  return env;
}

// ── Tool definition ───────────────────────────────────────────────────────────

export const claudeCodeTool: UnifiedTool = {
  name: "claude_code",
  description:
    "Execute a complete engineering task (build, code, test, git, repo creation, multi-step work) via the " +
    "Claude Code CLI agent in an isolated workspace. This is the PRIMARY way to do coding/build work — give it " +
    "the WHOLE task as one self-contained brief, not individual commands. Streams progress to the founder " +
    "and returns the final outcome. HITL-gated (one approval per task).",

  input_schema: {
    type: "object",
    properties: {
      task: {
        type: "string",
        description:
          "Complete, self-contained task brief: goal, constraints, where to put the result (e.g. 'create a " +
          "new repo under ~/Projects/<name>, build X, run it to verify, push to GitHub as <owner>/<name>').",
      },
      cwd: {
        type: "string",
        description:
          "Working directory within ~/Projects (default: ~/Projects/agent-workspace). " +
          "The FounderOS repo itself is not allowed.",
      },
    },
    required: ["task"],
  },

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const task = args["task"] as string | undefined;
    if (!task || task.trim().length === 0) {
      return { success: false, error: "claude_code requires a non-empty task argument." };
    }

    const binaryOverride = args["_binaryOverride"] as string | undefined;
    const binary = binaryOverride ?? findClaudeBinary();
    if (!binary || !existsSync(binary)) {
      return {
        success: false,
        error:
          `Claude Code CLI not found. Install: npm install -g @anthropic-ai/claude-code ` +
          `or set CLAUDE_CODE_BIN. Checked: ${CANDIDATE_PATHS.join(", ")}`,
      };
    }

    const cwdResult = resolveExecutorCwd(args["cwd"] as string | undefined);
    if (!cwdResult.ok) return { success: false, error: cwdResult.error };
    const cwd = cwdResult.cwd;

    // Optional progress callback — injected by the agent-tools wrapper so this
    // module stays free of Telegram imports for tests.
    const onProgress = args["_onProgress"] as ((line: string) => void) | undefined;

    const cliArgs = binaryOverride
      ? [] // test seam: /bin/pwd, /bin/false, /bin/echo run argument-free
      : [
          "-p", task,
          "--output-format", "stream-json",
          "--verbose",
          "--permission-mode", "acceptEdits",
          "--allowedTools", ALLOWED_TOOLS,
        ];

    log.info({ task: task.slice(0, 120), cwd }, "claude_code executor starting");

    return await new Promise<ToolResult>((resolvePromise) => {
      const child = spawn(binary, cliArgs, {
        cwd,
        env: buildExecutorEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });

      let finalResult: { text: string; isError: boolean } | null = null;
      let lastAssistantLine = "";
      let rawStdout = ""; // fallback for non-stream-json output (test seam)
      let stderrBuf = "";
      let lastProgressAt = 0;
      let settled = false;

      const settle = (result: ToolResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise(result);
      };

      const timer = setTimeout(() => {
        log.warn({ task: task.slice(0, 80) }, "claude_code timed out — killing child");
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
        settle({
          success: false,
          error: `Claude Code timed out after ${TIMEOUT_MS / 60_000} minutes. Partial progress may exist in ${cwd}. Last status: ${lastAssistantLine || "n/a"}`,
        });
      }, TIMEOUT_MS);

      const rl = createInterface({ input: child.stdout });
      rl.on("line", (line) => {
        rawStdout += line + "\n";
        const progress = progressLineFromEvent(line);
        if (progress) {
          lastAssistantLine = progress;
          const now = Date.now();
          if (onProgress && now - lastProgressAt >= PROGRESS_MIN_INTERVAL_MS) {
            lastProgressAt = now;
            onProgress(progress);
          }
        }
        const result = resultFromEvent(line);
        if (result) finalResult = result;
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderrBuf += chunk.toString("utf-8");
        if (stderrBuf.length > 8_000) stderrBuf = stderrBuf.slice(-8_000);
      });

      child.on("error", (err) => {
        settle({ success: false, error: `Claude Code failed to start: ${err.message}` });
      });

      child.on("close", (code) => {
        if (finalResult) {
          const text = finalResult.text.slice(0, MAX_RESULT_CHARS);
          log.info({ exitCode: code, isError: finalResult.isError, chars: text.length }, "claude_code completed");
          if (finalResult.isError) {
            settle({ success: false, error: `Claude Code reported an error:\n${text}` });
          } else {
            settle({ success: true, data: text });
          }
          return;
        }
        // No structured result (test seam binaries, or crash before result event)
        const fallback = rawStdout.trim().slice(0, MAX_RESULT_CHARS);
        if (code === 0) {
          settle({ success: true, data: fallback || "(Claude Code completed with no output)" });
        } else {
          settle({
            success: false,
            error: `Claude Code exited with code ${code}.\n${stderrBuf.trim() || fallback || "no output"}`,
          });
        }
      });
    });
  },
};
