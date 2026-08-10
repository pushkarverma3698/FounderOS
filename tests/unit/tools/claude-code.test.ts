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
