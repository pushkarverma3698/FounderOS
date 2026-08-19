/**
 * FounderOS v3 kernel — evaluate node (async answer-quality sink).
 * =================================================================
 * The terminal node after `synthesize`. It is the ONLY hook the answer evaluator
 * needs, and it deliberately lives here rather than inside the synthesizer:
 * scoring an answer is not part of writing one, and the two must be able to fail
 * independently.
 *
 * It starts an evaluation and returns immediately — nothing is awaited, no state
 * channel is written, and the reply the synthesizer produced is passed through
 * untouched. A `revise`-grade verdict changes nothing about what the founder sees;
 * HITL remains the only gate in this system.
 *
 * Only completed turns reach here. A turn that fails in plan/dispatch routes
 * straight to END, which is correct: there is no answer to score.
 */

import type { StepResult, TaskEnvelope } from "./contracts.js";
import type { KernelStateType, KernelUpdate } from "./state.js";
import { recordAnswerEvaluation, type CompletedTurn } from "../infra/answer-eval.js";
import type { AnswerJudgeStep } from "../infra/judge.js";

/** Per-step output chars carried into the evaluation; the judge clamps again on its own budget. */
export const EVAL_STEP_OUTPUT_MAX_CHARS = 4_000;

function stepOutputText(result: StepResult): string {
  if (result.status === "failed") {
    const { component, message, evidence } = result.failure;
    return `FAILED in ${component}: ${message}${evidence ? ` — ${evidence}` : ""}`;
  }
  const json = typeof result.output === "string" ? result.output : JSON.stringify(result.output);
  return (json ?? "").slice(0, EVAL_STEP_OUTPUT_MAX_CHARS);
}

/**
 * PURE: kernel state → the narrow record an evaluation needs. Planned steps with
 * no result are carried with an explicit "no result" marker rather than dropped —
 * an unaddressed step is exactly what the completeness dimension is looking for,
 * and silently omitting it would make the plan look smaller than it was.
 */
export function toCompletedTurn(state: KernelStateType): CompletedTurn {
  const planned: readonly TaskEnvelope[] = state.mission.plan?.steps ?? [];
  const byId = new Map(state.results.map((r) => [r.step_id, r]));
  const steps: AnswerJudgeStep[] = planned.map((envelope) => {
    const result = byId.get(envelope.step_id);
    return {
      stepId: envelope.step_id,
      objective: envelope.objective,
      status: result?.status === "ok" ? "ok" : "failed",
      output: result ? stepOutputText(result) : "no result was produced for this planned step",
    };
  });
  return {
    turnId: state.turn?.id || "unknown-turn",
    threadId: state.turn?.chat_id || "unknown-thread",
    goal: state.mission.goal,
    reply: state.reply ?? "",
    steps,
  };
}

/**
 * Fire the evaluation and return. Writes no state channels — the returned update
 * is empty by design, so this node cannot alter the reply even by accident.
 */
export function evaluateNode(state: KernelStateType): KernelUpdate {
  const turn = toCompletedTurn(state);
  if (turn.reply.trim().length > 0) recordAnswerEvaluation(turn);
  return {};
}
