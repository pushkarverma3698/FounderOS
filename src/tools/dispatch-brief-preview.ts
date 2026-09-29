/**
 * FounderOS — what the approval card shows of a brief
 * ===================================================
 * `src/gateway/approval-card.ts` cuts every approval card's preview at 1500 characters, with no
 * marker. That was survivable while a brief was seven short sections. With nine sections and a
 * standing-constraints block, an ordinary brief overflows it, and the first thing to go is the
 * END: Verification and Acceptance, the two sections the founder most needs to see before he
 * approves an unattended write to a repository.
 *
 * So the card shows a digest, budgeted per field so the total is under the card's cut-off by
 * construction, and it says how much of each field it clipped and what else is in the issue.
 * The issue itself is filed with the full body, unchanged.
 *
 * The five fields shown are the ones that define WHAT will be done and how it is judged:
 * Goal, Expected, Files (and new files), Verify, Accept. Problem, Evidence, Constraints and
 * Forbidden are named on the last line rather than shown.
 *
 * Pure. Lives here rather than in the gateway because the HITL wrapper is in src/agents, which
 * may not import src/gateway (verify:arch, gateway-imports).
 */

import { DEFAULT_ACCEPTANCE, type AntigravityTaskInput } from "./dispatch-antigravity.js";

/** Stay under approval-card.ts's 1500-character cut so nothing is cut without a marker. */
export const CARD_PREVIEW_MAX_CHARS = 1400;

/** Characters each field may take, before its clipping marker. */
export const CARD_FIELD_BUDGETS = {
  goal: 220,
  expected: 220,
  scope: 170,
  newFiles: 90,
  verification: 160,
  acceptance: 170,
} as const;

/** Longest warning quoted on the card. */
const CARD_WARNING_MAX = 170;

/** Room kept for the " … (+1234567 more)" marker a clipped field ends with. */
const CLIP_MARKER_RESERVE = 20;

/** Collapses whitespace, and clips to `max` characters with a marker that says how many were left out. */
export function clipForCard(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const keep = max - CLIP_MARKER_RESERVE;
  return `${flat.slice(0, keep).trimEnd()} … (+${flat.length - keep} more)`;
}

/**
 * The card preview for a dispatch: the five fields the founder approves on, then a line naming
 * the rest, then (only when some paths could not be checked) what was not verified.
 */
export function renderCardPreview(
  input: AntigravityTaskInput,
  opts: { readonly bodyChars: number; readonly warnings?: readonly string[] },
): string {
  const budget = CARD_FIELD_BUDGETS;
  const newFiles = input.newFiles?.trim();
  const firstWarning = opts.warnings?.[0];

  return [
    `Goal: ${clipForCard(input.goal, budget.goal)}`,
    `Expected: ${clipForCard(input.expected, budget.expected)}`,
    `Files: ${clipForCard(input.scope, budget.scope)}`,
    ...(newFiles ? [`New files: ${clipForCard(newFiles, budget.newFiles)}`] : []),
    `Verify: ${clipForCard(input.verification, budget.verification)}`,
    `Accept: ${clipForCard(input.acceptance?.trim() || DEFAULT_ACCEPTANCE, budget.acceptance)}`,
    `Also filed: Problem, Evidence, Constraints, Forbidden (full brief: ${opts.bodyChars} characters).`,
    ...(firstWarning ? [`Not verified: ${clipForCard(firstWarning, CARD_WARNING_MAX)}`] : []),
  ].join("\n");
}
