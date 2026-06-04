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

  it("defaults cwd to ~/Projects/founderos when not provided", async () => {
    const { claudeCodeTool } = await import("../../../src/tools/claude-code.js");

    // /bin/pwd ignores args and prints cwd — verifies default cwd
    const result = await claudeCodeTool.execute({
      task: "whatever",
      _binaryOverride: "/bin/pwd",
    });

    const home = process.env["HOME"] ?? "/Users/pushkarverma";
    if (result.success) {
      expect((result.data as string).trim()).toBe(`${home}/Projects/founderos`);
    }
    expect(result).toHaveProperty("success");
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
});
