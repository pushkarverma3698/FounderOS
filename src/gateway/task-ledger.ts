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

// ── Cross-department fan-out detection (T28/T29) ──────────────────────────────
// A single message that asks for a LinkedIn post AND/OR a GitHub issue (often on
// top of a research ask) must become an explicit ordered ledger. Without one the
// supervisor improvises the whole plan inside one ReAct loop — it recurses to the
// limit and, worse, drafts the post inline instead of calling the HITL-gated
// linkedin_post / github_write tools (so no approval card ever appears).

/** Asks to publish/draft a LinkedIn post (not just read comments or reply). */
const LINKEDIN_POST_RE =
  /\b(?:linkedin|li)\b[^.?!\n]{0,40}\bpost\b|\bpost\b[^.?!\n]{0,20}\b(?:on|to)\b[^.?!\n]{0,10}\blinkedin\b|\bdraft[^.?!\n]{0,30}\blinkedin\b/i;

/** Asks to open/create a GitHub issue. */
const GITHUB_ISSUE_RE =
  /\b(?:github|gh)\b[^.?!\n]{0,40}\bissue\b|\bissue\b[^.?!\n]{0,30}\b(?:github|gh|repo)\b|\bopen\b[^.?!\n]{0,20}\bissue\b/i;

/** A research/comparison lead-in that should run before any write step. */
const RESEARCH_HINT_RE =
  /\b(research|find|compare|teardown|analy[sz]e|alternatives?|versus|who wins|top \d)\b|\bvs\b/i;

/**
 * Intent text shared by any marketing step that ends in a LinkedIn publish.
 * It makes the HITL gate non-optional in deterministic code so approval-gate
 * phrasing ("gate before posting", "show me first") can never be read as
 * "skip the tool and paste a draft".
 */
const MARKETING_LINKEDIN_INTENT =
  "Write the complete, publish-ready post and call linkedin_post with the final text. " +
  "The linkedin_post approval card IS the founder's review gate — phrases like " +
  '"gate before posting" or "show me first" mean call the tool, never paste the draft as plain text.';

const ENGINEERING_ISSUE_INTENT =
  "Open the GitHub issue with github_write (HITL-gated). The approval card is the founder's review gate — do not skip it.";

/** Build an ordered fan-out ledger from detected write actions, or null. */
function detectFanOutLedger(input: string): TaskLedgerStep[] | null {
  const wantsLinkedIn = LINKEDIN_POST_RE.test(input);
  const wantsGithub = GITHUB_ISSUE_RE.test(input);
  if (!wantsLinkedIn && !wantsGithub) return null;

  const wantsResearch = RESEARCH_HINT_RE.test(input);
  const steps: TaskLedgerStep[] = [];
  if (wantsResearch) {
    steps.push({
      dept: "research",
      intent: "Research the topic with search_web (and search_turicks_brain for internal angle). Return findings verbatim.",
    });
  }
  if (wantsGithub) steps.push({ dept: "engineering", intent: ENGINEERING_ISSUE_INTENT });
  if (wantsLinkedIn) steps.push({ dept: "marketing", intent: MARKETING_LINKEDIN_INTENT });

  // A real fan-out needs at least two departments; a lone write stays normal routing.
  return steps.length >= 2 ? steps : null;
}

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
  return detectFanOutLedger(input);
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
