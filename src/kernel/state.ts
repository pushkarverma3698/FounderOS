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
import type { LessonCandidate } from "./lessons.js";

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

export type RecordUpdate<T> = Record<string, T[] | Reset | { set: T[] }> | Reset;

export function accumulatingRecord<T>() {
  return {
    reducer: (curr: Record<string, T[]>, update: RecordUpdate<T>): Record<string, T[]> => {
      if (update === RESET) return {};
      // Migration guard: stale checkpoints from before the isolated-records
      // upgrade (PR #345) store these channels as flat arrays. Discard them
      // — the dispatch node resets scratch/step_receipts every step anyway.
      const base = Array.isArray(curr) ? {} : curr;
      const next = { ...base };
      for (const [stepId, val] of Object.entries(update)) {
        if (val === RESET) {
          delete next[stepId];
        } else if (Array.isArray(val)) {
          next[stepId] = (next[stepId] ?? []).concat(val);
        } else {
          next[stepId] = val.set;
        }
      }
      return next;
    },
    default: () => ({}) as Record<string, T[]>,
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

  /** Worker-local working memory isolated by step_id; wiped at step boundaries. */
  scratch: Annotation<Record<string, BaseMessage[]>, RecordUpdate<BaseMessage>>(accumulatingRecord<BaseMessage>()),

  /** Receipts recorded (by code, not the model) while executing the active step. */
  step_receipts: Annotation<Record<string, ToolReceipt[]>, RecordUpdate<ToolReceipt>>(accumulatingRecord<ToolReceipt>()),

  /** The final founder-facing reply for this turn. */
  reply: Annotation<string>({
    reducer: (_curr, update) => update,
    default: () => "",
  }),

  /**
   * Failure-lesson bookkeeping for the ACTIVE retry: stashed when dispatch
   * builds a retry, settled (recorded or discarded) on the next dispatch pass.
   * Reset every turn by the plan node.
   */
  lesson_candidate: Annotation<LessonCandidate | null>({
    reducer: (_curr, update) => update,
    default: () => null,
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

/**
 * Silence that ends a conversation. Turns before a gap this long are a DIFFERENT
 * conversation and are dropped before the count and char caps apply.
 *
 * 2026-09-21, production: "Create a GitHub issue in FounderOS … label it
 * agent:ready" was answered with "I have recorded your preference … FounderOS will
 * ensure a PDF format is produced and delivered", and the founder's persistent
 * business context was rewritten. No issue was filed. The PDF instruction was
 * genuine but 4 days 14 hours old (2026-09-16 17:13, "I needed a pdf for it.
 * Remember this from next time also") and still inside the 20-turn window, which
 * that day spanned 4.5 days.
 *
 * A count cap cannot express "we stopped talking". On the single long-lived
 * Telegram thread this product actually runs on, it means each new day's first
 * message is planned against last week's.
 *
 * 6 hours: long enough that a working session — including the founder's 04:45 and
 * 20:31 ends of the day — stays one conversation, short enough that an overnight
 * or multi-day silence starts a clean one. Erring long is the silent failure
 * (invent an action from stale context); erring short is the loud one (ask what
 * "it" refers to).
 */
export const HISTORY_SESSION_GAP_MS = 6 * 60 * 60 * 1000;

/** Epoch ms for a summary's `at`, or null when it is missing/unparseable. */
function turnTime(t: TurnSummary): number | null {
  const ms = Date.parse(t.at);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Drop every turn before the most recent silence of >= HISTORY_SESSION_GAP_MS.
 *
 * An unreadable timestamp carries no gap information, so it never cuts: cutting
 * on it would silently wipe history, which is the same failure direction the
 * bound exists to remove. The count and char caps still bound whatever survives.
 */
function dropPriorSessions(list: TurnSummary[]): TurnSummary[] {
  for (let i = list.length - 1; i > 0; i--) {
    const curr = turnTime(list[i]!);
    const prev = turnTime(list[i - 1]!);
    if (curr === null || prev === null) continue;
    if (curr - prev >= HISTORY_SESSION_GAP_MS) return list.slice(i);
  }
  return list;
}

/**
 * Trim to the current session, then oldest-first to the turn cap and the total
 * char budget (always keeps the newest turn).
 */
export function trimHistory(list: TurnSummary[]): TurnSummary[] {
  const session = dropPriorSessions(list);
  let out = session.length > HISTORY_MAX_TURNS ? session.slice(-HISTORY_MAX_TURNS) : session;
  let chars = out.reduce((n, t) => n + t.user_input.length + t.reply.length, 0);
  while (out.length > 1 && chars > HISTORY_MAX_CHARS) {
    chars -= out[0]!.user_input.length + out[0]!.reply.length;
    out = out.slice(1);
  }
  return out;
}

export type KernelStateType = typeof KernelState.State;
export type KernelUpdate = typeof KernelState.Update;
