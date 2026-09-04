/**
 * FounderOS — OpenCode Executor (Engineering Department)
 * ==========================================================
 * The PRIMARY task executor for multi-step coding/build/repo work. Wraps the
 * OpenCode CLI headless (`opencode run`) so a whole task — "build a website,
 * create a repo, push it" — runs inside a real agent harness (strong model,
 * file tools, verification loop) instead of Gemini improvising one-shot shell
 * strings.
 *
 * Flow: founder asks for an engineering task → ONE HITL approval card (the
 * task brief) → opencode run runs in an isolated workspace → progress streamed
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
 *     "OpenCode is not logged in" failure).
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
  process.env["OPENCODE_BIN"],
  join(process.env["HOME"] ?? "/Users/pushkarverma", ".local/bin/opencode"),
  "/usr/local/bin/opencode",
  "/opt/homebrew/bin/opencode",
].filter(Boolean) as string[];

/** Returns the first resolvable OpenCode binary path, or null if not found. */
export function findOpenCodeBinary(): string | null {
  for (const candidate of CANDIDATE_PATHS) {
    if (existsSync(candidate)) return candidate;
  }
  try {
    const result = execSync("which opencode 2>/dev/null", { encoding: "utf-8", timeout: 3_000 });
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

/**
 * Standing directive appended to EVERY brief so the executor never stops at file
 * creation when the founder actually wants to see the result.
 *
 * Production bug (2026-06-13): "create fizzbuzz.py that prints 1..15" produced a
 * brief that said only "create the file" — opencode created it and stopped, so
 * the founder got no output and a SECOND opencode run (+ a SECOND HITL approval)
 * was needed just to run the file. Brief completeness can't depend on the Gemini
 * agent remembering "run it and report output" — so we enforce it deterministically
 * here (rule #16: push logic out of the LLM into code), independent of the brief.
 */
export const EXECUTION_DIRECTIVE =
  "\n\n---\nExecution requirement (always): if this task creates or modifies a runnable " +
  "script or program, after writing it you MUST run it and include the ACTUAL output/result " +
  "in your final report — never stop at file creation. Deliver the whole task in this one run; " +
  "do not defer running it to a separate step. Keep the final report concise.";

export const GROUNDING_MEMORY_DIRECTIVE =
  "\n\n---\nGrounding Directive (always): Reason strictly over repository files, turicks-brain memory, " +
  "failure_lessons, and live codebase state. Combine your parametric coding intelligence with the " +
  "founder's exact codebase context instead of overcomplicating tasks with ungrounded generic world assumptions.";

/** Append standing execution and grounding directives to a brief (idempotent). */
export function withExecutionDirective(task: string): string {
  let res = task.includes(EXECUTION_DIRECTIVE) ? task : task + EXECUTION_DIRECTIVE;
  if (!res.includes(GROUNDING_MEMORY_DIRECTIVE)) res += GROUNDING_MEMORY_DIRECTIVE;
  return res;
}

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
 * Validate and resolve the working directory for a OpenCode run.
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
        "Refused: OpenCode may not run inside the FounderOS repo — the bot must never modify its own " +
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
      return `⚙️ ${part.name}…`;
    }
  }
  return null;
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
 *      Use this when you want API-key auth for the OpenCode executor without
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

export const openCodeTool: UnifiedTool = {
  name: "opencode",
  description:
    "Execute a complete engineering task (build, code, test, git, repo creation, multi-step work) via the " +
    "OpenCode CLI agent in an isolated workspace. This is the PRIMARY way to do coding/build work — give it " +
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
      return { success: false, error: "opencode requires a non-empty task argument." };
    }

    const binaryOverride = args["_binaryOverride"] as string | undefined;
    const binary = binaryOverride ?? findOpenCodeBinary();
    if (!binary || !existsSync(binary)) {
      return {
        success: false,
        error:
          `OpenCode CLI not found. Install: npm install -g opencode-ai ` +
          `or set OPENCODE_BIN. Checked: ${CANDIDATE_PATHS.join(", ")}`,
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
          "-p", withExecutionDirective(task),
          "--output-format", "stream-json",
          "--verbose",
          "--permission-mode", "acceptEdits",
          "--allowedTools", ALLOWED_TOOLS,
        ];

    log.info({ task: task.slice(0, 120), cwd }, "opencode executor starting");

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
        log.warn({ task: task.slice(0, 80) }, "opencode timed out — killing child");
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
        settle({
          success: false,
          error: `OpenCode timed out after ${TIMEOUT_MS / 60_000} minutes. Partial progress may exist in ${cwd}. Last status: ${lastAssistantLine || "n/a"}`,
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
        settle({ success: false, error: `OpenCode failed to start: ${err.message}` });
      });

      child.on("close", (code) => {
        if (finalResult) {
          const text = finalResult.text.slice(0, MAX_RESULT_CHARS);
          log.info({ exitCode: code, isError: finalResult.isError, chars: text.length }, "opencode completed");
          if (finalResult.isError) {
            settle({ success: false, error: `OpenCode reported an error:\n${text}` });
          } else {
            settle({ success: true, data: text });
          }
          return;
        }
        // No structured result (test seam binaries, or crash before result event)
        const fallback = rawStdout.trim().slice(0, MAX_RESULT_CHARS);
        if (code === 0) {
          settle({ success: true, data: fallback || "(OpenCode completed with no output)" });
        } else {
          settle({
            success: false,
            error: `OpenCode exited with code ${code}.\n${stderrBuf.trim() || fallback || "no output"}`,
          });
        }
      });
    });
  },
};
