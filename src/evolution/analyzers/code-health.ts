/**
 * M0a — Evolution Engine v0: code-health static analyzers.
 * ========================================================
 * Pure analyzers inspecting prompt sizes, module test coverage, and LOC budgets
 * over already-read source text.
 */

import type { Finding, Severity, SourceFile } from "../types.js";
import { resolveImport } from "./dead-code.js";

export type { Finding, SourceFile } from "../types.js";

const IMPORT_SPEC_RE = /^\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/gm;

/** Worker prompt files max line budget before token bloat warning. */
export const PROMPT_MAX_LINES = 100;

/** Hard LOC budget enforced by CI architecture gates. */
export const LOC_HARD_BUDGET = 400;

/** Warning LOC threshold (90% of LOC_HARD_BUDGET). */
export const LOC_WARNING_THRESHOLD = 360;

function basenameOf(path: string): string {
  return path.split("/").pop()!.replace(/\.tsx?$/, "");
}

function pathWithoutExt(path: string): string {
  return path.replace(/\.tsx?$/, "");
}

/**
 * Worker prompt files living under src/agents/prompts/ that exceed 100 lines.
 */
export function findOversizedPrompts(files: readonly SourceFile[]): Finding[] {
  const findings: Finding[] = [];

  for (const file of files) {
    if (!file.path.startsWith("src/agents/prompts/")) continue;
    const lines = file.text.split("\n").length;

    if (lines > PROMPT_MAX_LINES) {
      findings.push({
        kind: "oversized-prompt",
        subject: file.path,
        evidence:
          `${file.path} is ${lines} lines, over the ${PROMPT_MAX_LINES}-line prompt budget. ` +
          `Every turn that routes to this worker pays for the whole prompt in input tokens.`,
        severity: "medium",
        location: file.path,
      });
    }
  }

  return findings;
}

/**
 * Source modules that have no reference in any test file.
 * Reachability is computed from resolved import specifiers, never raw file text.
 * Skips entry points (index.ts), index basenames, and pure schema declarations under src/db/.
 */
export function findUntestedModules(
  files: readonly SourceFile[],
  testFiles: readonly SourceFile[],
): Finding[] {
  const testedModuleIds = new Set<string>();
  for (const testFile of testFiles) {
    for (const [, spec] of testFile.text.matchAll(IMPORT_SPEC_RE)) {
      const resolved = resolveImport(testFile.path, spec!);
      if (resolved) testedModuleIds.add(resolved);
    }
  }

  const findings: Finding[] = [];

  for (const file of files) {
    const base = basenameOf(file.path);
    if (base === "index") continue;
    if (file.path.startsWith("src/db/") && base === "schema") continue;

    const noExt = pathWithoutExt(file.path);

    if (!testedModuleIds.has(noExt)) {
      findings.push({
        kind: "untested-module",
        subject: file.path,
        evidence: `No test file references module ${file.path}.`,
        severity: "low",
        location: file.path,
      });
    }
  }

  return findings;
}

/**
 * Files approaching or exceeding the 400-line architecture LOC budget.
 * Early warning at 360 lines (90% of budget), high severity above 400 lines.
 */
export function findFilesNearLocBudget(files: readonly SourceFile[]): Finding[] {
  const findings: Finding[] = [];

  for (const file of files) {
    const lineCount = file.text.split("\n").length;
    if (lineCount < LOC_WARNING_THRESHOLD) continue;

    const isOver = lineCount > LOC_HARD_BUDGET;
    const severity: Severity = isOver ? "high" : "medium";

    let evidence: string;
    if (isOver) {
      const over = lineCount - LOC_HARD_BUDGET;
      evidence = `${file.path} is ${lineCount} lines, exceeding the ${LOC_HARD_BUDGET}-line budget by ${over} line${over === 1 ? "" : "s"}.`;
    } else {
      const headroom = LOC_HARD_BUDGET - lineCount;
      evidence = `${file.path} is ${lineCount} lines, approaching the ${LOC_HARD_BUDGET}-line budget (${headroom} line${headroom === 1 ? "" : "s"} of headroom remaining).`;
    }

    findings.push({
      kind: "loc-pressure",
      subject: file.path,
      evidence,
      severity,
      location: file.path,
    });
  }

  return findings;
}
