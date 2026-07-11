/**
 * FounderOS v3 kernel — graph state channels.
 * ============================================
 * The LangGraph Annotation wrapper around the pure SystemState contracts.
 * Channels that accumulate (results, scratch, receipts, attempts) accept the
 * "reset" sentinel so the plan node can start every turn clean while the
 * SAME thread keeps its checkpoint history (append-only; never rewritten).
 */

import { Annotation } from "@langchain/langgraph";
import type { BaseMessage } from "@langchain/core/messages";
import type {
  FailureReport,
  Mission,
  StepResult,
  ToolReceipt,
  TurnRecord,
  TurnSummary,
} from "./contracts.js";

export const RESET = "reset" as const;
type Reset = typeof RESET;

/** Update grammar for accumulating channels: append (array), clear (RESET), or replace ({ set }). */
export type ListUpdate<T> = T[] | Reset | { set: T[] };

function accumulating<T>() {
  return {
    reducer: (curr: T[], update: ListUpdate<T>): T[] => {
      if (update === RESET) return [];
      if (Array.isArray(update)) return curr.concat(update);
      return update.set;
    },
    default: () => [] as T[],
  };
}

export const KernelState = Annotation.Root({
  turn: Annotation<TurnRecord>({
    reducer: (curr, update) => update ?? curr,
    default: () => ({ id: "", chat_id: "", received_at: "", raw_input: "" }),
  }),

  mission: Annotation<Mission>({
    reducer: (curr, update) => update ?? curr,
    default: () => ({ goal: "", status: "planning", plan: null, cursor: 0 }),
  }),

  /** Typed outputs of completed steps — the only inter-agent data bus. */
  results: Annotation<StepResult[], ListUpdate<StepResult>>(accumulating<StepResult>()),

  /** Retry bookkeeping per step_id (supervisor retries a retryable step once). */
  attempts: Annotation<Record<string, number>, Record<string, number> | Reset>({
    reducer: (curr, update) => (update === RESET ? {} : { ...curr, ...update }),
    default: () => ({}),
  }),

  /** Terminal failure — set once; the supervisor routes to the failure reply. */
  failure: Annotation<FailureReport | null>({
    reducer: (_curr, update) => update,
    default: () => null,
  }),

  /** Worker-local working memory for the ACTIVE step only; wiped at step boundaries. */
  scratch: Annotation<BaseMessage[], ListUpdate<BaseMessage>>(accumulating<BaseMessage>()),

  /** Receipts recorded (by code, not the model) while executing the active step. */
  step_receipts: Annotation<ToolReceipt[], ListUpdate<ToolReceipt>>(accumulating<ToolReceipt>()),

  /** The final founder-facing reply for this turn. */
  reply: Annotation<string>({
    reducer: (_curr, update) => update,
    default: () => "",
  }),

  /**
   * Snapshot of the turn CURRENTLY being processed, taken by the plan node.
   * Needed because the incoming `turn` update lands BEFORE plan runs — by
   * then the previous turn's input is gone from `turn`. The next turn's plan
   * node pairs this snapshot with the checkpointed `reply` to summarize.
   */
  last_turn: Annotation<TurnRecord | null>({
    reducer: (_curr, update) => update,
    default: () => null,
  }),

  /**
   * Cross-turn conversation memory — the ONLY channel that survives the plan
   * node's per-turn reset. Persisted in the thread checkpoint (Postgres in
   * prod), hydrated on every invoke, capped to the most recent turns.
   */
  history: Annotation<TurnSummary[], ListUpdate<TurnSummary>>({
    reducer: (curr, update) => {
      const next = update === RESET ? [] : Array.isArray(update) ? curr.concat(update) : update.set;
      return trimHistory(next);
    },
    default: () => [],
  }),
});

/** Bounds on retained turn summaries — keep checkpoint rows and planner prompts small. */
export const HISTORY_MAX_TURNS = 20;
/** Char budget across ALL retained summaries (~4k tokens) — protects the run budget on long threads. */
export const HISTORY_MAX_CHARS = 16_000;

/** Trim oldest-first to both the turn cap and the total char budget (always keeps the newest turn). */
function trimHistory(list: TurnSummary[]): TurnSummary[] {
  let out = list.length > HISTORY_MAX_TURNS ? list.slice(-HISTORY_MAX_TURNS) : list;
  let chars = out.reduce((n, t) => n + t.user_input.length + t.reply.length, 0);
  while (out.length > 1 && chars > HISTORY_MAX_CHARS) {
    chars -= out[0]!.user_input.length + out[0]!.reply.length;
    out = out.slice(1);
  }
  return out;
}

export type KernelStateType = typeof KernelState.State;
export type KernelUpdate = typeof KernelState.Update;
