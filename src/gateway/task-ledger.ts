/**
 * FounderOS — Task Ledger (deterministic multi-step orchestration)
 * ================================================================
 * Multi-department prompts get a pure, testable step list injected as a
 * SystemMessage. The Chief of Staff follows the ledger sequentially — it never
 * calls business tools itself (ADR-028).
 */

import type { RoutableDept } from "./pre-router.js";

/** A single step in a multi-department run. `synthesize` = COS text-only wrap-up. */
export type LedgerDept = RoutableDept | "synthesize";

export interface TaskLedgerStep {
  dept: LedgerDept;
  intent: string;
}

const MONDAY_BRIEF_RE =
  /\b(monday|weekly)\b[^.?!]{0,80}\b(github|issues?|context)\b|\b(github|issues?)\b[^.?!]{0,80}\b(monday|weekly|brief|plan)\b/i;

const RESEARCH_THEN_GITHUB_RE =
  /\bresearch\b[^.?!]{0,80}\b(then|and)\b[^.?!]{0,80}\b(github|issue)\b/i;

const MONDAY_BRIEF_STEPS: TaskLedgerStep[] = [
  {
    dept: "admin",
    intent:
      "Call read_context and search_memory for current business context and recent episodic memory relevant to the week ahead. Return the raw data.",
  },
  {
    dept: "engineering",
    intent: "Call github_read to list open GitHub issues for FounderOS only. Return the raw issue list.",
  },
  {
    dept: "synthesize",
    intent:
      "Synthesize a concise bullet plan for the week from the admin and engineering results. Text only — no tool calls.",
  },
];

/**
 * Detect a known multi-step pattern and return an ordered task ledger, or null
 * when the supervisor should route a single department normally.
 */
export function detectTaskLedger(input: string): TaskLedgerStep[] | null {
  if (!input?.trim()) return null;
  if (MONDAY_BRIEF_RE.test(input)) return MONDAY_BRIEF_STEPS;
  if (RESEARCH_THEN_GITHUB_RE.test(input)) {
    return [
      {
        dept: "research",
        intent: "Research the topic using search_web. Return findings verbatim.",
      },
      {
        dept: "engineering",
        intent: "Create the GitHub issue with the research findings using github_write (HITL-gated).",
      },
    ];
  }
  return null;
}

/** Build the SystemMessage directive the Chief of Staff must follow. */
export function buildTaskLedgerDirective(steps: TaskLedgerStep[]): string {
  const lines = steps.map(
    (s, i) =>
      `${i + 1}. ${s.dept === "synthesize" ? "Chief of Staff (you)" : `Transfer to ${s.dept}`}: ${s.intent}`,
  );
  return (
    `[TASK LEDGER: Multi-department request — execute steps IN ORDER, one department per transfer. ` +
    `The Chief of Staff has NO business tools — only route and relay.\n` +
    `${lines.join("\n")}\n` +
    `Complete every step before finishing. Relay each department's output verbatim before the next step.]`
  );
}

/** Re-export for pre-router multi-dept detection (shared regex semantics). */
export function isMultiDeptOrchestration(input: string): boolean {
  return detectTaskLedger(input) !== null;
}
