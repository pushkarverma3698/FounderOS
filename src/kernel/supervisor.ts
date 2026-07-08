/**
 * FounderOS v3 kernel — the supervisor.
 * ======================================
 * PURE CODE, no LLM call. This is the decisive architectural change: routing
 * used to be an 11.5 KB prompt re-sent on every hop and second-guessed by two
 * regex layers; now it is a total function over SystemState with unit tests.
 *
 * Responsibilities: read plan[cursor] → dispatch the next TaskEnvelope to a
 * worker (seeding its isolated scratch context), advance past ok steps, retry
 * a retryable failure exactly ONCE (visible in `attempts`), terminate on
 * anything else with a typed FailureReport. It performs no work itself.
 */

import { HumanMessage } from "@langchain/core/messages";
import { RESET } from "./state.js";
import type { KernelStateType, KernelUpdate } from "./state.js";
import type { FailureReport, StepResult, TaskEnvelope } from "./contracts.js";

export const MAX_ATTEMPTS_PER_STEP = 2; // 1 original + 1 visible retry

/**
 * Resolve envelope inputs against completed step outputs. The deterministic
 * reference rule: a string value that names an earlier step_id (e.g.
 * {"summary_from": "s1"}) is replaced by that step's validated output.
 * Anything else passes through untouched — no guessing.
 */
export function resolveInputs(
  inputs: Record<string, unknown>,
  results: StepResult[],
): Record<string, unknown> {
  const okOutputs = new Map<string, unknown>();
  for (const r of results) {
    if (r.status === "ok") okOutputs.set(r.step_id, r.output);
  }
  return Object.fromEntries(
    Object.entries(inputs).map(([k, v]) => [
      k,
      typeof v === "string" && okOutputs.has(v) ? okOutputs.get(v) : v,
    ]),
  );
}

/** The envelope message a worker starts from — its ENTIRE view of the world. */
export function envelopeMessage(envelope: TaskEnvelope, results: StepResult[]): HumanMessage {
  const resolved = { ...envelope, inputs: resolveInputs(envelope.inputs, results) };
  return new HumanMessage(
    `TASK ENVELOPE (respond per your instructions; finish with ONE JSON object matching "${envelope.expected.schema_ref}"):\n` +
      JSON.stringify(resolved, null, 2),
  );
}

/** Deterministic founder-facing failure reply — fail loud, name the component. */
export function formatFailureReply(failure: FailureReport): string {
  const lines = [
    `⚠️ Task stopped at step "${failure.step_id}" — ${failure.stage} failure in ${failure.component}.`,
    failure.message,
  ];
  if (failure.evidence) lines.push(`Evidence: ${failure.evidence.slice(0, 400)}`);
  lines.push(
    failure.stage === "hitl_rejected"
      ? "Nothing was sent. Re-ask if you change your mind."
      : "Nothing was invented and completed steps are preserved — the mission is resumable.",
  );
  return lines.join("\n");
}

function lastResultFor(stepId: string, results: StepResult[]): StepResult | undefined {
  for (let i = results.length - 1; i >= 0; i--) {
    if (results[i]!.step_id === stepId) return results[i]!;
  }
  return undefined;
}

/**
 * The dispatch node. Total: every branch returns a definite state update.
 */
export function dispatch(state: KernelStateType): KernelUpdate {
  const { mission, results, attempts } = state;
  const plan = mission.plan;
  if (!plan) {
    const failure: FailureReport = {
      step_id: "plan",
      stage: "routing",
      component: "kernel/supervisor",
      message: "Dispatch reached with no plan — planner contract violated.",
      retryable: false,
    };
    return { mission: { ...mission, status: "failed" }, failure, reply: formatFailureReply(failure) };
  }

  let cursor = mission.cursor;
  while (cursor < plan.steps.length) {
    const step = plan.steps[cursor]!;
    const last = lastResultFor(step.step_id, results);

    if (!last) {
      // Fresh (or retried) step: seed the worker's isolated context.
      const attempt = attempts[step.step_id] ?? 0;
      return {
        mission: { ...mission, status: "executing", cursor },
        attempts: { [step.step_id]: attempt + 1 },
        scratch: { set: [envelopeMessage(step, results)] },
        step_receipts: RESET,
      };
    }

    if (last.status === "ok") {
      cursor += 1;
      continue;
    }

    // Failed step: one visible retry for retryable failures, then terminate.
    const attempt = attempts[step.step_id] ?? 0;
    if (last.failure.retryable && attempt < MAX_ATTEMPTS_PER_STEP) {
      return {
        mission: { ...mission, status: "executing", cursor },
        attempts: { [step.step_id]: attempt + 1 },
        scratch: {
          set: [
            envelopeMessage(step, results),
            new HumanMessage(
              `RETRY ${attempt} of ${MAX_ATTEMPTS_PER_STEP - 1}: the previous attempt failed — ${last.failure.message}. ` +
                `Correct the issue and finish with valid JSON for "${step.expected.schema_ref}".`,
            ),
          ],
        },
        step_receipts: RESET,
        // The retried step's failed result must not shadow a later success:
        // drop it from the bus (results keeps ONLY non-superseded entries).
        results: { set: results.filter((r) => r !== last) },
      };
    }

    return {
      mission: { ...mission, status: "failed", cursor },
      failure: last.failure,
      reply: formatFailureReply(last.failure),
    };
  }

  // Every step completed ok.
  return { mission: { ...mission, status: "synthesizing", cursor } };
}

/** Conditional edge after dispatch. */
export function routeAfterDispatch(state: KernelStateType): "agent" | "synthesize" | "finish" {
  switch (state.mission.status) {
    case "executing":
      return "agent";
    case "synthesizing":
      return "synthesize";
    default:
      return "finish";
  }
}

/** Conditional edge after the plan node. */
export function routeAfterPlan(state: KernelStateType): "dispatch" | "finish" {
  return state.mission.status === "executing" ? "dispatch" : "finish";
}
