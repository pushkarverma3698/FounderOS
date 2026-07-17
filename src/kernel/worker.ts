/**
 * FounderOS v3 kernel — worker engine (agent ⇄ tools ⇄ collect).
 * ===============================================================
 * A worker executes exactly ONE TaskEnvelope in an isolated context: its own
 * system prompt + the envelope. It never sees the conversation, other steps'
 * chatter, or the planner prompt.
 *
 * Guarantees the old system lacked:
 *  - The tool budget TERMINATES the loop (budget exhausted → tools are unbound
 *    and the model is told to finalize; old code silently removed the tool from
 *    the schema and looped 10 more hops into GraphRecursionError).
 *  - Every tool execution emits a ToolReceipt recorded BY CODE at the call
 *    site — the ground truth that makes fabricated action claims impossible
 *    to validate (contracts.validateStepResult).
 *  - HITL interrupts propagate untouched: `interrupt()` inside a gated tool
 *    pauses the graph at THIS node; resume re-runs only this node.
 */

import {
  AIMessage,
  SystemMessage,
  ToolMessage,
  isAIMessage,
  isToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { isGraphInterrupt } from "@langchain/langgraph";
import type { RunnableConfig } from "@langchain/core/runnables";
import { jsonrepair } from "jsonrepair";
import {
  digestToolResult,
  hashToolArgs,
  repairTextSummaryOutput,
  validateStepResult,
  repairWrappedOutput,
  type StepResult,
  type TaskEnvelope,
  type ToolReceipt,
  type WorkerId,
} from "./contracts.js";
import { finalizeNudge, workerProtocol } from "./worker-protocol.js";
import type { KernelStateType, KernelUpdate } from "./state.js";
import type { KernelChatModel } from "./planner.js";
import { messageContentText } from "./message-text.js";
import { verifyStepResult } from "./verify.js";
import { describeInterceptedError, isKernelTerminalError } from "./errors.js";
import { clampToolOutput, pruneScratchForModel } from "./tool-output-guard.js";

/** Narrow tool surface. `config` carries thread_id for DB-backed HITL gates. */
export interface KernelTool {
  name: string;
  description?: string;
  invoke(args: Record<string, unknown>, config?: RunnableConfig): Promise<unknown>;
}

/** A model that can bind tools (BaseChatModel satisfies it; fakes return self). */
export interface KernelBindableModel extends KernelChatModel {
  bindTools?(tools: KernelTool[]): KernelChatModel;
}

export interface WorkerSpec {
  id: WorkerId;
  description: string;
  prompt: string;
  tools: KernelTool[];
}

/**
 * Deterministic failure convention for tool RESULTS (produced by code, never
 * parsed from model prose): a result is a failure iff it starts with "❌",
 * carries the structured [[TOOL_FAILURE …]] marker, or is a JSON envelope with
 * success/ok === false. hitlGate's rejection string starts with "❌" and
 * contains REJECTION_MARKER.
 */
export const TOOL_FAILURE_MARKER = "[[TOOL_FAILURE";
export const REJECTION_MARKER = "Rejected by founder";

export function isFailureResult(result: string): boolean {
  const head = result.trimStart();
  return (
    head.startsWith("❌") ||
    result.includes(TOOL_FAILURE_MARKER) ||
    /"(?:success|ok)"\s*:\s*false/.test(head.slice(0, 200))
  );
}

export function currentStep(state: KernelStateType): TaskEnvelope {
  const step = state.mission.plan?.steps[state.mission.cursor];
  if (!step) {
    throw new Error(
      `kernel invariant broken: worker reached with no active step (cursor ${state.mission.cursor})`,
    );
  }
  return step;
}

function executedToolCalls(scratch: BaseMessage[]): number {
  return scratch.filter((m) => isToolMessage(m)).length;
}

/** True when an identical (tool + args_hash) call already FAILED among these receipts. */
function alreadyFailedIdentically(receipts: ToolReceipt[], tool: string, argsHash: string): boolean {
  return receipts.some((r) => r.tool === tool && r.args_hash === argsHash && !r.ok);
}

/**
 * All receipts accrued so far in THIS turn: earlier completed steps carry theirs
 * on state.results (only OK-collected steps do), the active step on
 * state.step_receipts. Scope is one turn — `results` is RESET by the plan node,
 * so a failure never leaks across turns (a later turn may legitimately retry).
 * Pure: no I/O, deterministic in receipt order.
 */
export function turnReceipts(state: KernelStateType): ToolReceipt[] {
  const prior = state.results.flatMap((r) => ("tool_receipts" in r ? r.tool_receipts : []));
  return [...prior, ...Object.values(state.step_receipts).flat()];
}

/** LLM node: one model turn for the active step. */
export function makeAgentNode(model: KernelBindableModel, specs: Record<string, WorkerSpec>) {
  return async function agent(state: KernelStateType): Promise<KernelUpdate> {
    const step = currentStep(state);
    const spec = specs[step.worker];
    if (!spec) {
      // Planner referenced a worker with no runtime spec — typed routing failure.
      return {
        results: [
          {
            status: "failed",
            step_id: step.step_id,
            failure: {
              step_id: step.step_id,
              stage: "routing",
              component: "kernel/worker",
              message: `No worker spec registered for "${step.worker}".`,
              retryable: false,
            },
          } satisfies StepResult,
        ],
      };
    }

    const scratch = state.scratch[step.step_id] ?? [];
    const remaining = Math.max(0, step.constraints.max_tool_calls - executedToolCalls(scratch));
    const system = new SystemMessage(spec.prompt + workerProtocol(step, remaining));
    const bindable = remaining > 0 && spec.tools.length > 0 && model.bindTools
      ? model.bindTools(spec.tools)
      : model;
    // Read-time projection only — the checkpointed scratch stays untouched;
    // oldest oversized tool results are collapsed before the model re-reads them.
    // When the tool budget is spent, append a finalize nudge (NOT stored to
    // scratch): weak models sometimes return empty content on the terminal
    // turn, which collect() can only report as "did not finalize" (live
    // 2026-07-13, admin/text.summary). The nudge maximises a valid finalize
    // without fabricating anything.
    const invokeMsgs = [system, ...pruneScratchForModel(scratch)];
    if (remaining === 0 && executedToolCalls(scratch) > 0) invokeMsgs.push(finalizeNudge(step));
    // Self-correction seam: a model error that escapes the fallback chain used
    // to abort the WHOLE mission (completed steps discarded, raw error at the
    // gateway). Degrade it to a typed retryable failure so the supervisor's
    // own retry loop handles it; terminal errors (HITL interrupt, budget caps,
    // turn-timeout abort) still propagate untouched — see errors.ts.
    try {
      const response = await bindable.invoke(invokeMsgs);
      return { scratch: { [step.step_id]: [response] } };
    } catch (err) {
      if (isKernelTerminalError(err)) throw err;
      return {
        results: [
          {
            status: "failed",
            step_id: step.step_id,
            failure: {
              step_id: step.step_id,
              stage: "model",
              component: `kernel/worker:${step.worker}`,
              message: `Worker model call failed: ${describeInterceptedError(err)}`,
              retryable: true,
            },
          } satisfies StepResult,
        ],
      };
    }
  };
}

/** Stages the agent node records ITSELF (pre-collect) — collect must not double-record. */
const AGENT_RECORDED_STAGES: ReadonlySet<string> = new Set(["routing", "model"]);

function agentRecordedFailure(state: KernelStateType, stepId: string): boolean {
  return state.results.some(
    (r) => r.step_id === stepId && r.status === "failed" && AGENT_RECORDED_STAGES.has(r.failure.stage),
  );
}

/** Route after the agent turn: run tools, or collect the step result. */
export function routeAfterAgent(state: KernelStateType): "tools" | "collect" {
  // A routing/spec or intercepted-model failure short-circuits straight past tools.
  const step = state.mission.plan?.steps[state.mission.cursor];
  if (step && agentRecordedFailure(state, step.step_id)) {
    return "collect";
  }
  if (!step) return "collect";
  const scratch = state.scratch[step.step_id] ?? [];
  const last = scratch[scratch.length - 1];
  if (!last || !isAIMessage(last)) return "collect";
  const wantsTools = (last.tool_calls?.length ?? 0) > 0;
  if (!wantsTools) return "collect";
  const cap = step.constraints.max_tool_calls;
  // Budget exhausted → stop looping regardless of what the model wants.
  return executedToolCalls(scratch) < cap ? "tools" : "collect";
}

/** Tool-execution node: runs the pending calls, records receipts BY CODE. */
export function makeToolsNode(specs: Record<string, WorkerSpec>) {
  return async function tools(state: KernelStateType, config?: RunnableConfig): Promise<KernelUpdate> {
    const step = currentStep(state);
    const spec = specs[step.worker]!;
    const scratch = state.scratch[step.step_id] ?? [];
    const last = scratch[scratch.length - 1] as AIMessage;
    const cap = step.constraints.max_tool_calls;
    let executed = executedToolCalls(scratch);

    const messages: ToolMessage[] = [];
    const receipts: ToolReceipt[] = [];

    for (const call of last.tool_calls ?? []) {
      const callId = call.id ?? `${step.step_id}-${executed}`;
      if (executed >= cap) {
        messages.push(
          new ToolMessage({
            content: `TOOL_BUDGET_EXCEEDED — no more tool calls for this step. Finalize with the required JSON now.`,
            tool_call_id: callId,
            name: call.name,
          }),
        );
        continue;
      }
      const tool = spec.tools.find((t) => t.name === call.name);
      if (!tool) {
        messages.push(
          new ToolMessage({
            content: `❌ Unknown tool "${call.name}" for worker ${spec.id}. ${TOOL_FAILURE_MARKER} stage=validation]]`,
            tool_call_id: callId,
            name: call.name,
          }),
        );
        continue;
      }

      // Duplicate-failure guard (turn 49dbaa06): if this EXACT call already failed
      // anywhere in THIS turn — an earlier completed step (turnReceipts), the
      // active step (step_receipts), or earlier in this batch (receipts) — don't
      // re-invoke. Re-running proved-failing calls burns LLM roundtrips and
      // re-hits the failing external surface. No slot, no receipt; just tell the
      // model plainly not to repeat it. Scope is one turn: results reset per turn,
      // so a later turn may still legitimately retry.
      const argsHash = hashToolArgs(call.args ?? {});
      if (alreadyFailedIdentically([...turnReceipts(state), ...receipts], call.name, argsHash)) {
        messages.push(
          new ToolMessage({
            content: `❌ ${call.name} with these exact arguments already failed in this step — do NOT repeat it. Try a different approach or finalize with what you have. ${TOOL_FAILURE_MARKER} stage=tool]]`,
            tool_call_id: callId,
            name: call.name,
          }),
        );
        executed += 1;
        continue;
      }

      let resultStr: string;
      let ok: boolean;
      try {
        const raw = await tool.invoke((call.args ?? {}) as Record<string, unknown>, config);
        resultStr = typeof raw === "string" ? raw : JSON.stringify(raw);
        ok = !isFailureResult(resultStr);
      } catch (err) {
        // interrupt() MUST bubble so the checkpoint pauses here for HITL.
        if (isGraphInterrupt(err)) throw err;
        const message = err instanceof Error ? err.message : String(err);
        resultStr = `❌ ${call.name} threw: ${message} ${TOOL_FAILURE_MARKER} stage=tool]]`;
        ok = false;
      }
      executed += 1;
      // Receipt digest = FULL payload (ground truth); the model sees the clamped
      // version — a runaway scraper/DB result must not be replayed every hop.
      receipts.push({
        tool: call.name,
        args_hash: argsHash,
        result_digest: digestToolResult(resultStr),
        ok,
        at: new Date().toISOString(),
      });
      messages.push(new ToolMessage({ content: clampToolOutput(resultStr), tool_call_id: callId, name: call.name }));
    }

    return { scratch: { [step.step_id]: messages }, step_receipts: { [step.step_id]: receipts } };
  };
}

function tryParseJson(text: string): unknown | null {
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    try {
      return JSON.parse(jsonrepair(cleaned));
    } catch {
      return null;
    }
  }
}

/** PURE node: turn the step's scratch into a validated StepResult. */
export async function collect(state: KernelStateType): Promise<KernelUpdate> {
  const step = currentStep(state);

  // Routing/model failure already recorded by the agent node — nothing to collect.
  if (agentRecordedFailure(state, step.step_id)) {
    return {};
  }

  // Founder rejected a gated action → terminal for this step, never retried.
  const scratch = state.scratch[step.step_id] ?? [];
  const rejected = scratch.some(
    (m) => isToolMessage(m) && typeof m.content === "string" && m.content.includes(REJECTION_MARKER),
  );
  if (rejected) {
    return {
      results: [
        {
          status: "failed",
          step_id: step.step_id,
          failure: {
            step_id: step.step_id,
            stage: "hitl_rejected",
            component: step.worker,
            message: "Founder rejected the approval — the gated action was not executed.",
            retryable: false,
          },
        },
      ],
    };
  }

  const lastAi = [...scratch].reverse().find((m) => isAIMessage(m));
  // messageContentText, not a string typeof check: gemini-flash-latest started
  // returning parts arrays and string-only extraction killed honest finalizes
  // (live d211fb74 / 8c7e098f, 2026-07-11).
  const text = lastAi ? messageContentText(lastAi.content) : "";
  const parsedRaw = text ? tryParseJson(text) : null;
  // Salvage wrapped outputs for structured contracts too.
  const repairedRaw = repairWrappedOutput(parsedRaw, step.expected.schema_ref);
  // Live T01 repair: for the pure-text contract, a prose finalize IS the
  // payload — salvage it instead of failing an honest answer (contracts.ts).
  const parsed =
    step.expected.schema_ref === "text.summary" ? repairTextSummaryOutput(repairedRaw, text) : repairedRaw;

  const failedValidation = (message: string): KernelUpdate => ({
    results: [
      {
        status: "failed",
        step_id: step.step_id,
        failure: {
          step_id: step.step_id,
          stage: "validation",
          component: `kernel/worker:${step.worker}`,
          message,
          evidence: text.slice(0, 300),
          retryable: true,
        },
      },
    ],
  });

  if (parsed === null) {
    return failedValidation(`Worker did not finalize with JSON for "${step.expected.schema_ref}".`);
  }

  const candidate = {
    status: "ok" as const,
    step_id: step.step_id,
    output: parsed,
    tool_receipts: state.step_receipts[step.step_id] ?? [],
  };
  const validated = validateStepResult(candidate, step);
  if (!validated.ok) return failedValidation(validated.error);
  
  const verified = await verifyStepResult(validated.value, step);
  return { results: [verified] };
}
