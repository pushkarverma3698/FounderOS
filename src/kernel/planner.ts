/**
 * FounderOS v3 kernel — planner node.
 * ====================================
 * The ONE routing LLM call per turn. Input: the founder's message + the worker
 * catalog. Output: a PlannerDecision — either a direct reply (no tools needed)
 * or a Plan of 1–8 TaskEnvelopes, validated by contract before anything runs.
 * A plan that fails validation is a terminal, reported failure (stage:
 * "planning") — the kernel never "makes it work" from malformed routing.
 *
 * The model is INJECTED. Nothing in the kernel constructs a provider client —
 * that is what makes the whole graph testable offline at $0.
 */

import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import { jsonrepair } from "jsonrepair";
import {
  KERNEL_SCHEMA_VERSION,
  MAX_TOOL_CALLS_PER_STEP,
  OUTPUT_CONTRACTS,
  validatePlannerDecision,
  WORKERS,
  type FailureReport,
  type PlannerDecision,
  type TurnSummary,
  type WorkerId,
} from "./contracts.js";
import { RESET } from "./state.js";
import type { KernelStateType, KernelUpdate } from "./state.js";
import { formatFailureReply } from "./supervisor.js";

/** Minimal chat-model surface the kernel depends on (BaseChatModel satisfies it). */
export interface KernelChatModel {
  invoke(messages: BaseMessage[]): Promise<AIMessage>;
}

export interface WorkerCatalogEntry {
  id: WorkerId;
  description: string;
  toolNames: string[];
  /** Tools that pause for founder approval — the planner must set hitl_required. */
  gatedToolNames: string[];
}

/** Deterministic developer override: `[route directly to research] …` builds a 1-step plan without asking the model. */
export const ROUTE_OVERRIDE_RE = /^\s*\[route directly to (\w+)(?: department)?\]:?\s*/i;

export function parseRouteOverride(input: string): { worker: WorkerId; rest: string } | null {
  const m = ROUTE_OVERRIDE_RE.exec(input);
  if (!m) return null;
  const worker = m[1]!.toLowerCase() as WorkerId;
  if (!(WORKERS as readonly string[]).includes(worker)) return null;
  return { worker, rest: input.slice(m[0]!.length).trim() };
}

export function buildPlannerPrompt(catalog: WorkerCatalogEntry[]): string {
  const workerLines = catalog
    .map((w) => `- ${w.id}: ${w.description} tools=[${w.toolNames.join(", ")}]` +
      (w.gatedToolNames.length ? ` gated=[${w.gatedToolNames.join(", ")}]` : ""))
    .join("\n");
  const refs = Object.keys(OUTPUT_CONTRACTS).join(", ");
  return [
    `You are the FounderOS planner. Turn the founder's message into EITHER a direct reply OR an execution plan. Respond with ONE JSON object and nothing else.`,
    ``,
    `Direct reply (greetings, questions you can answer without tools, requests missing REQUIRED data like a recipient email — ask for the missing field instead of guessing):`,
    `{"type":"reply","text":"..."}`,
    ``,
    `Plan (any task needing tools):`,
    `{"type":"plan","plan":{"schema_version":${KERNEL_SCHEMA_VERSION},"goal":"<normalized task>","steps":[{"step_id":"s1","worker":"<id>","objective":"<explicit instruction>","inputs":{},"expected":{"kind":"data|draft|action_receipt","schema_ref":"<ref>"},"constraints":{"max_tool_calls":<1-${MAX_TOOL_CALLS_PER_STEP}>,"hitl_required":<bool>}}]}}`,
    ``,
    `Workers:\n${workerLines}`,
    ``,
    `Output schema_refs: ${refs}`,
    ``,
    `Rules:`,
    `- 1 step for single-department tasks; up to 8 for multi-step. Reference earlier outputs via inputs, e.g. {"summary_from":"s1"}.`,
    `- expected.kind is "action_receipt" whenever the step SENDS/POSTS/WRITES anything external; those steps also set hitl_required=true when using a gated tool.`,
    `- NEVER invent required data (emails, URLs, amounts). Missing required data → {"type":"reply"} asking for it.`,
    `- Questions about the founder, their business, work, or history are NOT direct replies: plan a step for the worker with context/memory tools (read_context, search_memory). Read first, then answer — never answer from priors or ask permission to check.`,
    `- Objectives are explicit and self-contained; workers see ONLY their envelope, not this conversation.`,
    `- Earlier turns of this conversation may precede the newest message. Resolve references ("it", "that draft", "send it") against them; a turn marked [turn failed] shows what was attempted and why it stopped. Copy any content a step needs from the conversation (drafts, names, addresses) VERBATIM into the objective/inputs — never a bare reference like "the previous email".`,
  ].join("\n");
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

function planningFailure(message: string, evidence?: string): FailureReport {
  return {
    step_id: "plan",
    stage: "planning",
    component: "kernel/planner",
    message,
    ...(evidence !== undefined ? { evidence } : {}),
    retryable: false,
  };
}

/** Build the deterministic 1-step plan for an explicit route override. */
export function overrideDecision(worker: WorkerId, task: string): PlannerDecision {
  return {
    type: "plan",
    plan: {
      schema_version: KERNEL_SCHEMA_VERSION,
      goal: task,
      steps: [
        {
          step_id: "s1",
          worker,
          objective: task,
          inputs: {},
          expected: { kind: "data", schema_ref: "text.summary" },
          constraints: { max_tool_calls: MAX_TOOL_CALLS_PER_STEP, hitl_required: false },
        },
      ],
    },
  };
}

/** Truncation bounds for history entries — keep checkpoints and prompts small. */
export const HISTORY_INPUT_MAX_CHARS = 600;
export const HISTORY_REPLY_MAX_CHARS = 1500;

/**
 * Summarize the PREVIOUS turn still sitting in the checkpointed state:
 * `last_turn` (its input, snapshotted by the previous plan run — the `turn`
 * channel already holds the NEW input by the time plan runs) paired with the
 * `reply`/`mission`/`failure` it produced. Pure; returns null on a fresh
 * thread or when the last turn produced no reply (e.g. still paused on HITL).
 */
export function summarizePreviousTurn(state: KernelStateType): TurnSummary | null {
  // Empty reply ⇒ the last turn never reached a terminal node (paused on a HITL
  // interrupt) — do not summarize it yet; it completes via resume and is folded
  // in on the turn after. (A completed turn always has a non-empty reply: direct
  // replies/failures set it in the plan node, synthesis appends receipts.)
  if (!state.last_turn?.id || !state.reply) return null;
  const outcome = state.failure ? "failed" : state.mission.plan ? "done" : "replied";
  return {
    turn_id: state.last_turn.id,
    at: state.last_turn.received_at,
    user_input: state.last_turn.raw_input.slice(0, HISTORY_INPUT_MAX_CHARS),
    goal: state.mission.goal,
    outcome,
    reply: state.reply.slice(0, HISTORY_REPLY_MAX_CHARS),
  };
}

/** Render turn summaries as real conversation messages for the planner call. */
export function historyMessages(history: TurnSummary[]): BaseMessage[] {
  return history.flatMap((t) => [
    new HumanMessage(t.user_input),
    new AIMessage(t.outcome === "failed" ? `[turn failed] ${t.reply}` : t.reply),
  ]);
}

/**
 * Plan node factory. Resets all per-turn channels first (same thread, fresh
 * mission — the checkpoint history itself is append-only and untouched).
 * The previous turn is folded into the `history` channel HERE — the single
 * choke point every turn passes through — so all terminal paths (direct
 * reply, synthesis, typed failure) are remembered without instrumenting
 * each node.
 */
export function makePlanNode(model: KernelChatModel, catalog: WorkerCatalogEntry[]) {
  const systemPrompt = buildPlannerPrompt(catalog);

  return async function plan(state: KernelStateType): Promise<KernelUpdate> {
    const input = state.turn.raw_input.trim();
    const previous = summarizePreviousTurn(state);
    const conversation = previous ? [...state.history, previous] : state.history;
    const base: KernelUpdate = {
      results: RESET,
      attempts: RESET,
      scratch: RESET,
      step_receipts: RESET,
      failure: null,
      reply: "",
      last_turn: state.turn,
      ...(previous ? { history: [previous] } : {}),
    };

    if (!input) {
      const failure = planningFailure("Empty input — nothing to plan.");
      return {
        ...base,
        mission: { goal: "", status: "failed", plan: null, cursor: 0 },
        failure,
        reply: formatFailureReply(failure),
      };
    }

    const override = parseRouteOverride(input);
    const decision: PlannerDecision | FailureReport = override
      ? overrideDecision(override.worker, override.rest || input)
      : await (async () => {
          const response = await model.invoke([
            new SystemMessage(systemPrompt),
            ...historyMessages(conversation),
            new HumanMessage(input),
          ]);
          const text = typeof response.content === "string" ? response.content : JSON.stringify(response.content);
          const parsed = tryParseJson(text);
          if (parsed === null) {
            return planningFailure("Planner did not return JSON.", text.slice(0, 400));
          }
          const validated = validatePlannerDecision(parsed);
          return validated.ok ? validated.value : planningFailure(validated.error, text.slice(0, 400));
        })();

    if ("stage" in decision) {
      return {
        ...base,
        mission: { goal: input, status: "failed", plan: null, cursor: 0 },
        failure: decision,
        reply: formatFailureReply(decision),
      };
    }
    if (decision.type === "reply") {
      return {
        ...base,
        mission: { goal: input, status: "done", plan: null, cursor: 0 },
        reply: decision.text,
      };
    }
    return {
      ...base,
      mission: { goal: decision.plan.goal, status: "executing", plan: decision.plan, cursor: 0 },
    };
  };
}
