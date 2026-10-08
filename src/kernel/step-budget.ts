/**
 * Per-step tool budget. Code sets it by step class; the number the planner wrote is ignored.
 * Extracted from contracts.ts to keep the LOC budget (rule R4).
 *
 * Two caps: MAX_READ_TOOL_CALLS_PER_STEP (20) for a read-intent step (hitl_required false and not an
 * action_receipt) and MAX_TOOL_CALLS_PER_STEP (10) for any step that can write or is HITL-gated.
 *
 * Why not the planner's number: the planner is a cheap model that often wrote 3, which starved simple
 * action steps ("Tool budget reached (3 calls)") and left cleanup asks half done. A budget is not a
 * judgment the model is good at, so code picks it.
 *
 * A bigger budget does not bypass approval: every side-effecting tool calls hitlGate() inline on EVERY
 * call (src/agents/agent-tools/), so the founder is asked per action whatever the step's cap.
 */

import { MAX_READ_TOOL_CALLS_PER_STEP, MAX_TOOL_CALLS_PER_STEP, type TaskEnvelope } from "./contracts.js";

export { MAX_READ_TOOL_CALLS_PER_STEP };

/** The cap a step runs under, decided by its class. `constraints.max_tool_calls` (the planner's guess) is ignored. */
export function clampStepCalls(step: Pick<TaskEnvelope, "constraints" | "expected">): number {
  return isReadIntentStep(step) ? MAX_READ_TOOL_CALLS_PER_STEP : MAX_TOOL_CALLS_PER_STEP;
}

/** Return the step with its cap set by class (same object when nothing changes). */
export function clampStep<T extends TaskEnvelope>(step: T): T {
  const cap = clampStepCalls(step);
  if (cap === step.constraints.max_tool_calls) return step;
  return { ...step, constraints: { ...step.constraints, max_tool_calls: cap } };
}

export function isReadIntentStep(step: Pick<TaskEnvelope, "constraints" | "expected">): boolean {
  return step.constraints.hitl_required === false && step.expected.kind !== "action_receipt";
}

const NOTE_TAIL = "Anything that objective asked for and the output does not show was NOT verified.";

export function capReachedNote(step: Pick<TaskEnvelope, "objective" | "constraints">): string {
  const calls = step.constraints.max_tool_calls;
  const objective = JSON.stringify(step.objective.slice(0, 200));
  return "Tool budget reached (" + calls + " calls) on: " + objective + ". " + NOTE_TAIL;
}
