/**
 * M0a — Evolution Engine v0: code-health analyzers unit tests.
 * =============================================================
 * Unit tests covering true-positive and false-positive cases for prompt size,
 * module test coverage, and LOC budget analyzers.
 */

import { describe, expect, it } from "vitest";
import {
  LOC_HARD_BUDGET,
  LOC_WARNING_THRESHOLD,
  PROMPT_MAX_LINES,
  findFilesNearLocBudget,
  findOversizedPrompts,
  findUntestedModules,
  type SourceFile,
} from "../../../src/evolution/analyzers/code-health.js";

const file = (path: string, text: string): SourceFile => ({ path, text });

function makeLines(count: number): string {
  return Array.from({ length: count }, (_, i) => `// line ${i + 1}`).join("\n");
}

describe("findOversizedPrompts", () => {
  it("flags prompt files in src/agents/prompts/ over 100 lines", () => {
    const promptFile = file("src/agents/prompts/marketing.ts", makeLines(105));

    const findings = findOversizedPrompts([promptFile]);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: "oversized-prompt",
      subject: "src/agents/prompts/marketing.ts",
      severity: "medium",
      location: "src/agents/prompts/marketing.ts",
    });
    expect(findings[0]?.evidence).toContain("105 lines");
    expect(findings[0]?.evidence).toContain(`${PROMPT_MAX_LINES}-line prompt budget`);
  });

  it("does NOT flag prompt files with 100 lines or fewer", () => {
    const promptFile = file("src/agents/prompts/short.ts", makeLines(100));

    expect(findOversizedPrompts([promptFile])).toEqual([]);
  });

  it("does NOT flag files outside src/agents/prompts/ even if over 100 lines", () => {
    const nonPromptFile = file("src/agents/marketing.ts", makeLines(150));

    expect(findOversizedPrompts([nonPromptFile])).toEqual([]);
  });
});

describe("findUntestedModules", () => {
  it("flags a src module that is not referenced in any test file", () => {
    const srcFiles = [file("src/kernel/untested.ts", "export const x = 1;")];
    const testFiles = [file("tests/unit/other.test.ts", 'import { y } from "src/kernel/other";')];

    const findings = findUntestedModules(srcFiles, testFiles);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: "untested-module",
      subject: "src/kernel/untested.ts",
      severity: "low",
      location: "src/kernel/untested.ts",
    });
    expect(findings[0]?.evidence).toContain("src/kernel/untested.ts");
  });

  it("does NOT flag a module referenced by path without extension", () => {
    const srcFiles = [file("src/kernel/worker.ts", "export const worker = {};")];
    const testFiles = [
      file("tests/unit/worker.test.ts", 'import { worker } from "../../src/kernel/worker";'),
    ];

    expect(findUntestedModules(srcFiles, testFiles)).toEqual([]);
  });

  it("does NOT flag a module referenced by /<basename>.js", () => {
    const srcFiles = [file("src/kernel/worker.ts", "export const worker = {};")];
    const testFiles = [
      file("tests/unit/kernel/worker.test.ts", 'import { worker } from "../../../src/kernel/worker.js";'),
    ];

    expect(findUntestedModules(srcFiles, testFiles)).toEqual([]);
  });

  it("does NOT treat a same-named module in another directory as coverage", () => {
    const srcFiles = [file("src/outreach/graph.ts", "export const g = 1;")];
    const testFiles = [
      file("tests/unit/kernel/graph.test.ts", 'import { x } from "../../../src/kernel/graph.js";'),
    ];

    const findings = findUntestedModules(srcFiles, testFiles);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.subject).toBe("src/outreach/graph.ts");
  });

  it("does NOT treat a path-prefix sibling as coverage", () => {
    const srcFiles = [file("src/kernel/worker.ts", "export const w = 1;")];
    const testFiles = [
      file(
        "tests/unit/kernel/worker-utils.test.ts",
        'import { u } from "../../../src/kernel/worker-utils";',
      ),
    ];

    const findings = findUntestedModules(srcFiles, testFiles);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.subject).toBe("src/kernel/worker.ts");
  });

  it("does NOT flag entry points, index basenames, or src/db/ schema files", () => {
    const srcFiles = [
      file("src/index.ts", "export const boot = 1;"),
      file("src/utils/index.ts", "export const util = 1;"),
      file("src/db/schema.ts", "export const tables = {};"),
      file("src/db/models/schema.ts", "export const subTables = {};"),
    ];
    const testFiles: SourceFile[] = [];

    expect(findUntestedModules(srcFiles, testFiles)).toEqual([]);
  });
});

describe("findFilesNearLocBudget", () => {
  it("flags files approaching 400 lines (360-400 lines) with medium severity", () => {
    const srcFile = file("src/approaching.ts", makeLines(370));

    const findings = findFilesNearLocBudget([srcFile]);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: "loc-pressure",
      subject: "src/approaching.ts",
      severity: "medium",
      location: "src/approaching.ts",
    });
    expect(findings[0]?.evidence).toContain("370 lines");
    expect(findings[0]?.evidence).toContain(`${LOC_HARD_BUDGET}-line budget`);
    expect(findings[0]?.evidence).toContain("30 lines of headroom remaining");
  });

  it("flags files exceeding 400 lines with high severity", () => {
    const srcFile = file("src/over.ts", makeLines(415));

    const findings = findFilesNearLocBudget([srcFile]);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: "loc-pressure",
      subject: "src/over.ts",
      severity: "high",
      location: "src/over.ts",
    });
    expect(findings[0]?.evidence).toContain("415 lines");
    expect(findings[0]?.evidence).toContain("exceeding the 400-line budget by 15 lines");
  });

  it("does NOT flag files under 360 lines", () => {
    const srcFile = file("src/small.ts", makeLines(LOC_WARNING_THRESHOLD - 1));

    expect(findFilesNearLocBudget([srcFile])).toEqual([]);
  });
});
