/**
 * Unit tests for the claude_code tool (engineering department).
 * TDD: RED first — src/tools/claude-code.ts doesn't exist yet.
 *
 * claude_code wraps the Claude Code CLI (`claude --print --no-interactive`)
 * so the engineering agent can delegate complex AI coding tasks to it.
 * Always HITL-gated at the LangChain wrapper level.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── RED tests — will fail until implementation exists ─────────────────────────

describe("claudeCodeTool — shape", () => {
  it("has name 'claude_code'", async () => {
    const { claudeCodeTool } = await import("../../../src/tools/claude-code.js");
    expect(claudeCodeTool.name).toBe("claude_code");
  });

  it("description mentions 'Claude Code' and 'CLI'", async () => {
    const { claudeCodeTool } = await import("../../../src/tools/claude-code.js");
    expect(claudeCodeTool.description).toMatch(/Claude Code/i);
    expect(claudeCodeTool.description).toMatch(/CLI/i);
  });

  it("has an execute function", async () => {
    const { claudeCodeTool } = await import("../../../src/tools/claude-code.js");
    expect(typeof claudeCodeTool.execute).toBe("function");
  });

  it("input_schema requires 'task' field", async () => {
    const { claudeCodeTool } = await import("../../../src/tools/claude-code.js");
    const schema = claudeCodeTool.input_schema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(schema.required).toContain("task");
    expect(schema.properties).toHaveProperty("task");
    expect(schema.properties).toHaveProperty("cwd");
  });
});

describe("claudeCodeTool — findClaudeBinary()", () => {
  it("returns a path string (or null when not found)", async () => {
    const { findClaudeBinary } = await import("../../../src/tools/claude-code.js");
    const result = findClaudeBinary();
    // Must be a string path or null — never throws
    expect(result === null || typeof result === "string").toBe(true);
  });
});

describe("claudeCodeTool — execute()", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns success:false with helpful message when claude binary not found", async () => {
    const { claudeCodeTool } = await import("../../../src/tools/claude-code.js");

    const result = await claudeCodeTool.execute({
      task: "write a hello world function",
      _binaryOverride: "/nonexistent/claude",
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found|install|claude/i);
  });

  it("returns success:false (not a throw) on execution failure", async () => {
    const { claudeCodeTool } = await import("../../../src/tools/claude-code.js");

    // /bin/false always exits with code 1 — tests the error-handling contract
    const result = await claudeCodeTool.execute({
      task: "this is a test task",
      _binaryOverride: "/bin/false",
    });

    // Must return a result object, never throw
    expect(result).toHaveProperty("success");
    expect(result.success).toBe(false);
  });

  it("returns success:true with output when binary runs successfully", async () => {
    const { claudeCodeTool } = await import("../../../src/tools/claude-code.js");

    // /bin/echo prints its args to stdout — exercises the happy path
    const result = await claudeCodeTool.execute({
      task: "hello world",
      _binaryOverride: "/bin/echo",
    });

    expect(result.success).toBe(true);
    expect(typeof result.data).toBe("string");
    expect((result.data as string).length).toBeGreaterThan(0);
  });

  it("defaults cwd to the isolated agent workspace (NOT the FounderOS repo)", async () => {
    const { claudeCodeTool, defaultWorkspace } = await import("../../../src/tools/claude-code.js");

    // /bin/pwd ignores args and prints cwd — verifies default cwd
    const result = await claudeCodeTool.execute({
      task: "whatever",
      _binaryOverride: "/bin/pwd",
    });

    expect(result.success).toBe(true);
    expect((result.data as string).trim()).toBe(defaultWorkspace());
  });

  it("respects explicit cwd argument", async () => {
    const { claudeCodeTool } = await import("../../../src/tools/claude-code.js");
    const home = process.env["HOME"] ?? "/Users/pushkarverma";

    const result = await claudeCodeTool.execute({
      task: "whatever",
      cwd: `${home}/Projects`,
      _binaryOverride: "/bin/pwd",
    });

    if (result.success) {
      expect((result.data as string).trim()).toBe(`${home}/Projects`);
    }
    expect(result).toHaveProperty("success");
  });

  it("HARD-BLOCKS running inside the FounderOS repo (self-modification guard)", async () => {
    const { claudeCodeTool, founderosRepoPath } = await import("../../../src/tools/claude-code.js");

    const result = await claudeCodeTool.execute({
      task: "whatever",
      cwd: founderosRepoPath(),
      _binaryOverride: "/bin/pwd",
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/FounderOS repo|own.*code/i);
  });

  it("blocks subdirectories of the FounderOS repo too", async () => {
    const { claudeCodeTool, founderosRepoPath } = await import("../../../src/tools/claude-code.js");

    const result = await claudeCodeTool.execute({
      task: "whatever",
      cwd: `${founderosRepoPath()}/src`,
      _binaryOverride: "/bin/pwd",
    });

    expect(result.success).toBe(false);
  });
});

describe("buildExecutorEnv — credential isolation", () => {
  it("strips ANTHROPIC_* vars so the CLI uses its own stored login (no executor key)", async () => {
    const { buildExecutorEnv } = await import("../../../src/tools/claude-code.js");
    const env = buildExecutorEnv({
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "sk-ant-critic-key",
      ANTHROPIC_BASE_URL: "https://api.anthropic.com",
      HOME: "/Users/test",
    });
    expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();
    expect(env["ANTHROPIC_BASE_URL"]).toBeUndefined();
    expect(env["PATH"]).toBe("/usr/bin");
    expect(env["HOME"]).toBe("/Users/test");
  });

  it("passes CLAUDE_EXECUTOR_API_KEY as ANTHROPIC_API_KEY to child when set", async () => {
    const { buildExecutorEnv } = await import("../../../src/tools/claude-code.js");
    const env = buildExecutorEnv({
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "sk-ant-critic-key",
      CLAUDE_EXECUTOR_API_KEY: "sk-ant-executor-key",
      HOME: "/Users/test",
    });
    // Executor key is forwarded as ANTHROPIC_API_KEY for the child CLI
    expect(env["ANTHROPIC_API_KEY"]).toBe("sk-ant-executor-key");
    // Bot's own critic key never leaks through
    expect(env["CLAUDE_EXECUTOR_API_KEY"]).toBeUndefined();
    expect(env["PATH"]).toBe("/usr/bin");
  });

  it("forwards CLAUDE_EXECUTOR_BASE_URL as ANTHROPIC_BASE_URL to child when set", async () => {
    const { buildExecutorEnv } = await import("../../../src/tools/claude-code.js");
    const env = buildExecutorEnv({
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "sk-ant-critic-key",
      ANTHROPIC_BASE_URL: "https://api.anthropic.com",
      CLAUDE_EXECUTOR_API_KEY: "sk-or-v1-executor",
      CLAUDE_EXECUTOR_BASE_URL: "https://openrouter.ai/api/v1",
    });
    expect(env["ANTHROPIC_API_KEY"]).toBe("sk-or-v1-executor");
    expect(env["ANTHROPIC_BASE_URL"]).toBe("https://openrouter.ai/api/v1");
    // Bot's own base URL never leaks
    expect(env["CLAUDE_EXECUTOR_BASE_URL"]).toBeUndefined();
  });

  it("strips CLAUDE* SDK session vars regardless of executor key", async () => {
    const { buildExecutorEnv } = await import("../../../src/tools/claude-code.js");
    const env = buildExecutorEnv({
      CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH: "1",
      CLAUDECODE: "1",
      CLAUDE_EXECUTOR_API_KEY: "sk-ant-executor-key",
      HOME: "/Users/test",
    });
    expect(env["CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH"]).toBeUndefined();
    expect(env["CLAUDECODE"]).toBeUndefined();
    expect(env["ANTHROPIC_API_KEY"]).toBe("sk-ant-executor-key");
  });
});

describe("stream-json parsing", () => {
  it("extracts assistant text as a progress line", async () => {
    const { progressLineFromEvent } = await import("../../../src/tools/claude-code.js");
    const evt = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Creating the repo structure now" }] },
    });
    expect(progressLineFromEvent(evt)).toBe("Creating the repo structure now");
  });

  it("extracts tool_use as a HUMANISED progress line (no raw tool-name jargon)", async () => {
    const { progressLineFromEvent } = await import("../../../src/tools/claude-code.js");
    const evt = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash" }] },
    });
    // Regression (2026-06-12): Telegram showed "⚙️ Write…"/"⚙️ Bash…" — internal
    // tool names — so the founder couldn't tell what the agent was doing. The
    // progress line must be plain English, never the raw tool name.
    const line = progressLineFromEvent(evt)!;
    expect(line).toBe("▶️ Running a command…");
    expect(line).not.toContain("Bash");
  });

  it("humanises every known tool name and falls back gracefully", async () => {
    const { humanizeToolProgress } = await import("../../../src/tools/claude-code.js");
    expect(humanizeToolProgress("Write")).toBe("✍️ Writing a file");
    expect(humanizeToolProgress("Edit")).toBe("✏️ Editing the code");
    expect(humanizeToolProgress("WebSearch")).toBe("🌐 Searching the web");
    // Unknown tools never leak their raw name
    const fallback = humanizeToolProgress("SomeInternalTool");
    expect(fallback).toBe("🛠 Working on it");
    expect(fallback).not.toContain("SomeInternalTool");
  });

  it("returns null for non-assistant events and garbage lines", async () => {
    const { progressLineFromEvent } = await import("../../../src/tools/claude-code.js");
    expect(progressLineFromEvent(JSON.stringify({ type: "system" }))).toBeNull();
    expect(progressLineFromEvent("not json at all")).toBeNull();
  });

  it("extracts the final result event with error flag", async () => {
    const { resultFromEvent } = await import("../../../src/tools/claude-code.js");
    const ok = resultFromEvent(JSON.stringify({ type: "result", subtype: "success", result: "Done: repo pushed.", is_error: false }));
    expect(ok).toEqual({ text: "Done: repo pushed.", isError: false });
    const err = resultFromEvent(JSON.stringify({ type: "result", subtype: "error_max_turns", result: "ran out", is_error: true }));
    expect(err).toEqual({ text: "ran out", isError: true });
    expect(resultFromEvent(JSON.stringify({ type: "assistant" }))).toBeNull();
  });
});
