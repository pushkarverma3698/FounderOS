/**
 * Unit tests for src/tools/claude-code.ts
 */

import { describe, it, expect, vi } from "vitest";
import {
  findClaudeBinary,
  withExecutionDirective,
  EXECUTION_DIRECTIVE,
  founderosRepoPath,
  defaultWorkspace,
  claudeCodeTool,
} from "../../../src/tools/claude-code.js";

describe("claude-code helper functions", () => {
  it("appends EXECUTION_DIRECTIVE to brief idempotently", () => {
    const brief = "Build a script that calculates fibonacci(10)";
    const enriched = withExecutionDirective(brief);

    expect(enriched).toContain(brief);
    expect(enriched).toContain(EXECUTION_DIRECTIVE);

    // Calling it again should not duplicate the directive
    const doubleEnriched = withExecutionDirective(enriched);
    expect(doubleEnriched).toBe(enriched);
  });

  it("resolves default workspace paths correctly under home directory", () => {
    const repoPath = founderosRepoPath();
    const wsPath = defaultWorkspace();

    expect(repoPath).toContain("Projects/founderos");
    expect(wsPath).toContain("Projects/agent-workspace");
  });

  it("finds claude binary or returns null gracefully", () => {
    const bin = findClaudeBinary();
    // In CI or environments without claude installed it returns string or null
    expect(bin === null || typeof bin === "string").toBe(true);
  });
});

describe("claude-code executor — external AbortSignal (AG-015/B6)", () => {
  // Until this fix, the outer turn-timeout guard's abort() never reached the
  // spawned `claude` CLI child process at all — execute() had no way to even
  // receive it, so the process kept running (real repo/GitHub side effects)
  // after the founder was told the turn had stopped.

  it("settles with a clear failure and does not hang when the signal aborts mid-run", async () => {
    const controller = new AbortController();
    const resultPromise = claudeCodeTool.execute({
      task: "irrelevant — binary override bypasses the CLI invocation",
      // /usr/bin/yes runs forever with no args and ignores empty stdin — the
      // test-seam binaries this file already documents (/bin/pwd, /bin/false,
      // /bin/echo) all exit immediately, so a long-lived process needs its own.
      _binaryOverride: "/usr/bin/yes",
      _signal: controller.signal,
    });

    await new Promise((r) => setTimeout(r, 150)); // let the child actually spawn
    controller.abort();

    const result = await resultPromise;
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/abort/i);
  });

  it("kills immediately if the signal is already aborted before the child settles", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await claudeCodeTool.execute({
      task: "irrelevant",
      _binaryOverride: "/usr/bin/yes",
      _signal: controller.signal,
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/abort/i);
  });

  it("a signal that never aborts does not affect a normal completion", async () => {
    const controller = new AbortController();
    const result = await claudeCodeTool.execute({
      task: "irrelevant",
      _binaryOverride: "/bin/echo", // exits immediately, success path
      _signal: controller.signal,
    });
    expect(result.success).toBe(true);
  });
});
