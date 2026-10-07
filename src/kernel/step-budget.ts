/**
 * Per-step tool budget (AG-035) — read-only investigation gets room, anything that can write does not.
 * Extracted from contracts.ts to keep the LOC budget (rule R4).
 *
 * Two caps: MAX_TOOL_CALLS_PER_STEP (6) for any step that can write or is HITL-gated, and
 * MAX_READ_TOOL_CALLS_PER_STEP (15) for a step whose bound tools are ALL read-only.
 *
 * "Read-only" fails CLOSED: a tool is read-only only if it is on READ_ONLY_TOOLS AND is not in
 * HITL_GATED_TOOLS. An unknown or new tool is therefore never read-only until someone adds it here,
 * and tests/unit/kernel/step-budget.test.ts fails if any tool that calls hitlGate() is listed.
 *
 * A planner step above 6 calls that is not a write step (hitl_required false, not an action_receipt)
 * has its bound tools NARROWED to the read-only subset (stepTools), so the larger budget can never
 * reach a write tool. Steps at 6 calls or fewer are untouched.
 */

import { HITL_GATED_TOOLS } from "../infra/hitl.js";
import { MAX_READ_TOOL_CALLS_PER_STEP, MAX_TOOL_CALLS_PER_STEP, type TaskEnvelope } from "./contracts.js";

export { MAX_READ_TOOL_CALLS_PER_STEP };
const WRITE_STEP_MAX_CALLS = MAX_TOOL_CALLS_PER_STEP;

/** Tools that only read. Anything not listed here is treated as able to write. */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "github_read",
  "read_context",
  "read_file",
  "list_dir",
  "read_logs",
  "recall_conversation",
  "search_knowledge",
  "search_memory",
  "search_research_cache",
  "read_emails",
  "read_cv",
  "ops_state",
  "antigravity_task_status",
  "get_gap_scans",
  "list_scheduled",
  "list_scheduled_posts",
  "list_reminders",
  "list_workflows",
  "list_pending_signals",
  "list_brand_assets",
  "list_video_brands",
  "video_production_status",
  "linkedin_get_my_posts",
  "linkedin_analytics",
  "linkedin_read_comments",
]);

/** The cap a step actually runs under: the read cap only for read-intent steps, 6 for everything else. */
export function clampStepCalls(step: Pick<TaskEnvelope, "constraints" | "expected">): number {
  const asked = step.constraints.max_tool_calls;
  if (asked <= WRITE_STEP_MAX_CALLS) return asked;
  return isReadIntentStep(step) ? Math.min(asked, MAX_READ_TOOL_CALLS_PER_STEP) : WRITE_STEP_MAX_CALLS;
}

/** Return the step with its cap clamped (same object when nothing changes). */
export function clampStep<T extends TaskEnvelope>(step: T): T {
  const cap = clampStepCalls(step);
  if (cap === step.constraints.max_tool_calls) return step;
  return { ...step, constraints: { ...step.constraints, max_tool_calls: cap } };
}

export function isReadOnlyTool(name: string): boolean {
  return READ_ONLY_TOOLS.has(name) && !HITL_GATED_TOOLS.has(name);
}

export function isReadIntentStep(step: Pick<TaskEnvelope, "constraints" | "expected">): boolean {
  const needsApproval = step.constraints.hitl_required;
  return needsApproval === false && step.expected.kind !== "action_receipt";
}

type Named = { name: string };

/** Tools to bind for a step. Narrowed to read-only only when a read-intent step asked for more than the write cap. */
export function stepTools<T extends Named>(step: Pick<TaskEnvelope, "constraints" | "expected">, tools: T[]): T[] {
  if (step.constraints.max_tool_calls <= WRITE_STEP_MAX_CALLS) return tools;
  if (!isReadIntentStep(step)) return tools;
  return tools.filter((t) => isReadOnlyTool(t.name));
}

const NOTE_TAIL = "Anything that objective asked for and the output does not show was NOT verified.";

export function capReachedNote(step: Pick<TaskEnvelope, "objective" | "constraints">): string {
  const calls = step.constraints.max_tool_calls;
  const objective = JSON.stringify(step.objective.slice(0, 200));
  return "Tool budget reached (" + calls + " calls) on: " + objective + ". " + NOTE_TAIL;
}
