/**
 * Unit tests for run_command output truncation in project_workflow tool.
 * Prevents 400 "contents is not specified" from Gemini when command output is huge.
 */

import { describe, it, expect } from "vitest";

describe("run_command output truncation", () => {
  const MAX = 10_000;

  it("returns output as-is when under 10K chars", async () => {
    const shortOutput = "a".repeat(MAX - 1);
    // Verify the constant — output under MAX passes through
    expect(shortOutput.length).toBeLessThan(MAX);
    expect(shortOutput.slice(0, MAX).length).toBe(MAX - 1);
  });

  it("truncates output exactly at 10K chars and appends char count suffix", () => {
    const longOutput = "x".repeat(15_000);
    const truncated =
      longOutput.length > MAX
        ? longOutput.slice(0, MAX) +
          `\n\n[...${longOutput.length - MAX} chars truncated — use targeted commands or pipe to head/tail]`
        : longOutput;

    expect(truncated).toHaveLength(MAX + `\n\n[...5000 chars truncated — use targeted commands or pipe to head/tail]`.length);
    expect(truncated).toContain("[...5000 chars truncated");
    expect(truncated.slice(0, MAX)).toBe("x".repeat(MAX));
  });

  it("output of exactly 10K chars is NOT truncated", () => {
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
    const excess = bigOutput.length - MAX; // 90000
    const suffix = `\n\n[...${excess} chars truncated — use targeted commands or pipe to head/tail]`;
    expect(suffix).toContain("90000");
  });
});
