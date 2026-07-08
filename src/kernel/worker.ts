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
  HumanMessage,
  SystemMessage,
  ToolMessage,
  isAIMessage,
  isToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { isGraphInterrupt } from "@langchain/langgraph";
import { jsonrepair } from "jsonrepair";
import {
  digestToolResult,
  hashToolArgs,
  validateStepResult,
  type StepResult,
  type TaskEnvelope,
  type ToolReceipt,
  type WorkerId,
} from "./contracts.js";
import type { KernelStateType, KernelUpdate } from "./state.js";
import type { KernelChatModel } from "./planner.js";

/** Narrow tool surface (LangChain StructuredTool satisfies it). */
export interface KernelTool {
  name: string;
  description?: string;
  invoke(args: Record<string, unknown>): Promise<unknown>;
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

function workerProtocol(step: TaskEnvelope, remainingCalls: number): string {
  return [
    ``,
    `EXECUTION PROTOCOL:`,
    `- You are completing ONE step: "${step.objective}"`,
    `- Tool calls remaining for this step: ${remainingCalls}. When it reaches 0 you MUST finalize.`,
    `- Finalize by replying with ONE JSON object satisfying schema "${step.expected.schema_ref}" — no prose around it.`,
    `- Report failures honestly; never fabricate tool output. Rejected approvals are final.`,
  ].join("\n");
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

    const remaining = Math.max(0, step.constraints.max_tool_calls - executedToolCalls(state.scratch));
    const system = new SystemMessage(spec.prompt + workerProtocol(step, remaining));
    const bindable = remaining > 0 && spec.tools.length > 0 && model.bindTools
      ? model.bindTools(spec.tools)
      : model;
    const response = await bindable.invoke([system, ...state.scratch]);
    return { scratch: [response] };
  };
}

/** Route after the agent turn: run tools, or collect the step result. */
export function routeAfterAgent(state: KernelStateType): "tools" | "collect" {
  // A routing/spec failure short-circuits straight past tools.
  const step = state.mission.plan?.steps[state.mission.cursor];
  if (step && state.results.some((r) => r.step_id === step.step_id && r.status === "failed" && r.failure.stage === "routing")) {
    return "collect";
  }
  const last = state.scratch[state.scratch.length - 1];
  if (!last || !isAIMessage(last)) return "collect";
  const wantsTools = (last.tool_calls?.length ?? 0) > 0;
  if (!wantsTools) return "collect";
  const cap = step?.constraints.max_tool_calls ?? 0;
  // Budget exhausted → stop looping regardless of what the model wants.
  return executedToolCalls(state.scratch) < cap ? "tools" : "collect";
}

/** Tool-execution node: runs the pending calls, records receipts BY CODE. */
export function makeToolsNode(specs: Record<string, WorkerSpec>) {
  return async function tools(state: KernelStateType): Promise<KernelUpdate> {
    const step = currentStep(state);
    const spec = specs[step.worker]!;
    const last = state.scratch[state.scratch.length - 1] as AIMessage;
    const cap = step.constraints.max_tool_calls;
    let executed = executedToolCalls(state.scratch);

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

      let resultStr: string;
      let ok: boolean;
      try {
        const raw = await tool.invoke((call.args ?? {}) as Record<string, unknown>);
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
      receipts.push({
        tool: call.name,
        args_hash: hashToolArgs(call.args ?? {}),
        result_digest: digestToolResult(resultStr),
        ok,
        at: new Date().toISOString(),
      });
      messages.push(new ToolMessage({ content: resultStr, tool_call_id: callId, name: call.name }));
    }

    return { scratch: messages, step_receipts: receipts };
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
export function collect(state: KernelStateType): KernelUpdate {
  const step = currentStep(state);

  // Routing failure already recorded by the agent node — nothing to collect.
  if (state.results.some((r) => r.step_id === step.step_id && r.status === "failed" && r.failure.stage === "routing")) {
    return {};
  }

  // Founder rejected a gated action → terminal for this step, never retried.
  const rejected = state.scratch.some(
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

  const lastAi = [...state.scratch].reverse().find((m) => isAIMessage(m));
  const text = lastAi && typeof lastAi.content === "string" ? lastAi.content : "";
  const parsed = text ? tryParseJson(text) : null;

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
    tool_receipts: state.step_receipts,
  };
  const validated = validateStepResult(candidate, step);
  if (!validated.ok) return failedValidation(validated.error);
  return { results: [validated.value] };
}
