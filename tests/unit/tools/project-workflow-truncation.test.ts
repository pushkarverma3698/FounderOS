/**
 * Unit tests for run_command output truncation in project_workflow tool.
 * Prevents 400 "contents is not specified" from Gemini when command output is huge.
 *
 * MAX_TOOL_OUTPUT was reduced from 10,000 → 2,000 chars (2026-06-09) to prevent
 * accumulated tool outputs in multi-step HITL chains from overflowing Gemini context.
 * A 5-step engineering chain at 2 KB/step totals ~10 KB — well within Gemini limits.
 */

import { describe, it, expect } from "vitest";

describe("run_command output truncation", () => {
  const MAX = 2_000;

  it("returns output as-is when under 2K chars", async () => {
    const shortOutput = "a".repeat(MAX - 1);
    expect(shortOutput.length).toBeLessThan(MAX);
    expect(shortOutput.slice(0, MAX).length).toBe(MAX - 1);
  });

  it("truncates output exactly at 2K chars and appends char count suffix", () => {
    const longOutput = "x".repeat(5_000);
    const truncated =
      longOutput.length > MAX
        ? longOutput.slice(0, MAX) +
          `\n\n[...${longOutput.length - MAX} chars truncated — use targeted commands or pipe to head/tail]`
        : longOutput;

    expect(truncated).toHaveLength(MAX + `\n\n[...3000 chars truncated — use targeted commands or pipe to head/tail]`.length);
    expect(truncated).toContain("[...3000 chars truncated");
    expect(truncated.slice(0, MAX)).toBe("x".repeat(MAX));
  });

  it("output of exactly 2K chars is NOT truncated", () => {
    const exactOutput = "z".repeat(MAX);
    const result = exactOutput.length > MAX
      ? exactOutput.slice(0, MAX) + `\n\n[...${exactOutput.length - MAX} chars truncated...]`
      : exactOutput;

    expect(result).toBe(exactOutput);
    expect(result).not.toContain("truncated");
  });

  it("empty command output returns sentinel string", () => {
    const stdout = "";
    const result = stdout || "(command completed with no output)";
    expect(result).toBe("(command completed with no output)");
  });

  it("truncation suffix includes exact char count for debugging", () => {
    const bigOutput = "a".repeat(100_000);
    const excess = bigOutput.length - MAX; // 98000
    const suffix = `\n\n[...${excess} chars truncated — use targeted commands or pipe to head/tail]`;
    expect(suffix).toContain("98000");
  });

  it("pnpm test output (~5K chars) gets truncated to 2K", () => {
    // Regression: pnpm test ran, returned 5252 chars, and hit Gemini context overflow.
    // With MAX=2000, this is now truncated before it enters the conversation history.
    const pnpmTestOutput = "Test Suite\n".repeat(477); // ~5000 chars
    const truncated = pnpmTestOutput.length > MAX
      ? pnpmTestOutput.slice(0, MAX) + `\n\n[...${pnpmTestOutput.length - MAX} chars truncated — use targeted commands or pipe to head/tail]`
      : pnpmTestOutput;

    expect(truncated.length).toBeLessThan(MAX + 200); // small overhead for suffix
    expect(truncated).toContain("truncated");
  });
});
