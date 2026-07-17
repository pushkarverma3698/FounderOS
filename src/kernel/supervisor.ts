/**
 * FounderOS v3 kernel — the supervisor.
 * ======================================
 * PURE CODE, no LLM call. This is the decisive architectural change: routing
 * used to be an 11.5 KB prompt re-sent on every hop and second-guessed by two
 * regex layers; now it is a total function over SystemState with unit tests.
 *
 * Responsibilities: read plan[cursor] → dispatch the next TaskEnvelope to a
 * worker (seeding its isolated scratch context), advance past ok steps, retry
 * a retryable failure with ESCALATION (visible in `attempts`): one corrected
 * retry, then one final DIAGNOSTIC retry that forces an approach change and
 * re-states the exact output contract. Terminate on anything else with a
 * typed FailureReport. It performs no work itself.
 */

import { HumanMessage } from "@langchain/core/messages";
import { RESET } from "./state.js";
import type { KernelStateType, KernelUpdate } from "./state.js";
import { getSchemaTemplate } from "./contracts.js";
import type { FailureReport, StepResult, TaskEnvelope } from "./contracts.js";

export const MAX_ATTEMPTS_PER_STEP = 3; // 1 original + 1 corrected retry + 1 diagnostic retry

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

/**
 * Escalating retry instruction (pure). `attempt` = attempts already dispatched,
 * so the retry being built is attempt N+1:
 *   - corrected retry: name the failure, demand the fix (unchanged v3 message —
 *     lessons.ts and the golden set key off its "RETRY x of y" prefix);
 *   - final DIAGNOSTIC retry: force an approach change, re-state the exact
 *     output contract, and carry the failure evidence — the model must stop
 *     iterating on a proven-dead path before the step goes terminal.
 */
export function retryMessage(step: TaskEnvelope, failure: FailureReport, attempt: number): HumanMessage {
  const isFinal = attempt + 1 >= MAX_ATTEMPTS_PER_STEP;
  if (!isFinal) {
    return new HumanMessage(
      `RETRY ${attempt} of ${MAX_ATTEMPTS_PER_STEP - 1}: the previous attempt failed — ${failure.message}. ` +
        `Correct the issue and finish with valid JSON for "${step.expected.schema_ref}".`,
    );
  }
  const lines = [
    `DIAGNOSTIC RETRY ${attempt} of ${MAX_ATTEMPTS_PER_STEP - 1} (FINAL attempt): every previous attempt failed — ${failure.message}.`,
    `Your previous approach is proven not to work. Change it:`,
    `- If a tool call failed, use a DIFFERENT tool or DIFFERENT arguments (identical failed calls are blocked).`,
    `- If output validation failed, reply with ONLY one JSON object exactly matching "${step.expected.schema_ref}":`,
    getSchemaTemplate(step.expected.schema_ref),
  ];
  if (failure.evidence) lines.push(`Evidence from the failed attempt: ${failure.evidence.slice(0, 300)}`);
  lines.push(`If the objective is genuinely impossible with your tools, finalize honestly with what you verified — never fabricate.`);
  return new HumanMessage(lines.join("\n"));
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

  const okStepIds = new Set(results.filter(r => r.status === "ok").map(r => r.step_id));
  const failedStepIds = new Set(results.filter(r => r.status === "failed").map(r => r.step_id));

  let nextStepIdx = -1;
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i]!;
    const completed = okStepIds.has(step.step_id);
    if (!completed) {
      const deps = step.dependencies ?? [];
      const depsOk = deps.every(d => okStepIds.has(d));
      if (depsOk) {
        nextStepIdx = i;
        break;
      }
    }
  }

  if (nextStepIdx !== -1) {
    const step = plan.steps[nextStepIdx]!;
    const last = lastResultFor(step.step_id, results);

    if (!last) {
      const attempt = attempts[step.step_id] ?? 0;
      return {
        mission: { ...mission, status: "executing", cursor: nextStepIdx },
        attempts: { [step.step_id]: attempt + 1 },
        scratch: { [step.step_id]: { set: [envelopeMessage(step, results)] } },
        step_receipts: { [step.step_id]: RESET },
      };
    }

    const attempt = attempts[step.step_id] ?? 0;
    if (last.status === "failed" && last.failure.retryable && attempt < MAX_ATTEMPTS_PER_STEP) {
      return {
        mission: { ...mission, status: "executing", cursor: nextStepIdx },
        attempts: { [step.step_id]: attempt + 1 },
        scratch: {
          [step.step_id]: {
            set: [envelopeMessage(step, results), retryMessage(step, last.failure, attempt)],
          },
        },
        results: { set: results.filter((r) => r !== last) },
      };
    }

    const failureReport = last.status === "failed" ? last.failure : {
      step_id: step.step_id,
      stage: "validation" as const,
      component: "supervisor",
      message: "Step failed with invalid status.",
      retryable: false,
    };
    return {
      mission: { ...mission, status: "failed", cursor: nextStepIdx },
      failure: failureReport,
      reply: formatFailureReply(failureReport),
    };
  }

  const failedStep = results.find(r => r.status === "failed");
  if (failedStep && failedStep.status === "failed") {
    return {
      mission: { ...mission, status: "failed" },
      failure: failedStep.failure,
      reply: formatFailureReply(failedStep.failure),
    };
  }

  return { mission: { ...mission, status: "synthesizing" } };
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
