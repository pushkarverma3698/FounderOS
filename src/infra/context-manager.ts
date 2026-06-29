/**
 * FounderOS — Context Manager (rolling-window message trimmer)
 * =============================================================
 * Problem: LangGraph's PostgresSaver stores ALL messages in a thread forever.
 * On every LLM call the supervisor and each sub-agent see the entire accumulated
 * history — O(n) tokens per call, growing without bound.
 *
 * Solution: trim the history to a token budget BEFORE each LLM call. The
 * checkpointer state is unchanged — full history is still persisted and /reset
 * still works.
 *
 * Uses trimMessages from @langchain/core/messages (v0.3.80, installed,
 * previously unused). Passed as the `prompt` parameter to createReactAgent /
 * createSupervisor, which accepts a MessageModifier function.
 *
 * Token budgets:
 *   Supervisor:  6000 tokens — needs to see routing context
 *   Sub-agents:  4000 tokens — tool-focused, short memory is enough
 *
 * Pure-ish: the function factory is pure; the returned modifier is async (due
 * to trimMessages being a Runnable) but has no side effects.
 */

import { trimMessages, SystemMessage, ToolMessage, isAIMessage, isToolMessage, isHumanMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { createMiddleware, dynamicSystemPromptMiddleware } from "langchain";
import type { AnyAgentMiddleware } from "langchain";
import { isStructuredToolFailure } from "../agents/tool-result.js";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Default per-message char cap (~3k tokens) before truncation. */
export const DEFAULT_MAX_MESSAGE_CHARS = 12_000;

export interface TrimOptions {
  /** Token budget for history (excluding system message). Default: 4000. */
  maxTokens?: number;
  /** Max chars per message before truncation. Default: 12000. */
  maxMessageChars?: number;
  /** Per-tool completed-call caps enforced deterministically in middleware. */
  toolCallLimits?: Record<string, number>;
  /** When true, strip all tools after any [[TOOL_FAILURE]] tool result (engineering). */
  stopToolsAfterFailure?: boolean;
  /**
   * Roadmap #11 — task-anchor projection. When true, the FIRST human message
   * (the anchoring task) is always preserved across trimming, even in a long
   * thread where strategy:"last" would otherwise drop it. Deterministic — a
   * pure state projection of the task, not an LLM summary. Default OFF so the
   * existing rolling-window behaviour is byte-identical until opted in.
   */
  preserveTaskAnchor?: boolean;
}

/**
 * The shape returned by createTrimmedPrompt.
 *
 * LangGraph 0.2.x passes the full state object { messages: BaseMessage[] }
 * to the prompt function at runtime, even though the TypeScript type says
 * BaseMessage[]. We accept `any` here and unwrap at runtime — the cast in
 * office.ts silences the static mismatch.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MessageModifier = (input: any) => Promise<BaseMessage[]>;

// ── Token estimation ──────────────────────────────────────────────────────────

/**
 * Fast approximation: 1 token ≈ 4 characters (English prose).
 * Accurate within ±15% for GPT-4, Claude, Gemini tokenizers.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Estimate total tokens across an array of messages.
 * Exported for tests and observability.
 */
export function estimateMessageTokens(messages: BaseMessage[]): number {
  return messages.reduce((sum, m) => {
    const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    return sum + estimateTokens(text);
  }, 0);
}

export function stripMessageNames(messages: BaseMessage[]): BaseMessage[] {
  return messages.map((m) => {
    if (m.name == null) return m;
    const clone = Object.assign(Object.create(Object.getPrototypeOf(m)), m) as BaseMessage;
    (clone as { name?: string }).name = undefined;
    return clone;
  });
}

export function countCompletedToolCalls(messages: BaseMessage[], toolName: string): number {
  const pendingIds = new Set<string>();
  let completed = 0;

  for (const message of messages) {
    if (isAIMessage(message)) {
      for (const toolCall of message.tool_calls ?? []) {
        if (toolCall.name === toolName && toolCall.id) {
          pendingIds.add(toolCall.id);
        }
      }
      continue;
    }

    if (!isToolMessage(message)) continue;

    const toolCallId = message.tool_call_id;
    if (toolCallId && pendingIds.has(toolCallId)) {
      pendingIds.delete(toolCallId);
      completed += 1;
      continue;
    }

    if ((message as { name?: string }).name === toolName) {
      completed += 1;
    }
  }

  return completed;
}

/** Tool calls scheduled in AI messages but not yet answered by ToolMessage. */
export function countPendingToolCalls(messages: BaseMessage[], toolName: string): number {
  const pendingIds = new Set<string>();

  for (const message of messages) {
    if (isAIMessage(message)) {
      for (const toolCall of message.tool_calls ?? []) {
        if (toolCall.name === toolName && toolCall.id) {
          pendingIds.add(toolCall.id);
        }
      }
      continue;
    }

    if (!isToolMessage(message)) continue;
    const toolCallId = message.tool_call_id;
    if (toolCallId) pendingIds.delete(toolCallId);
  }

  return pendingIds.size;
}

export function countScheduledToolCalls(messages: BaseMessage[], toolName: string): number {
  return countCompletedToolCalls(messages, toolName) + countPendingToolCalls(messages, toolName);
}

function clampOversizedMessages(messages: BaseMessage[], maxChars: number): BaseMessage[] {
  return messages.map((message) => {
    if (typeof message.content !== "string" || message.content.length <= maxChars) {
      return message;
    }
    const dropped = message.content.length - maxChars;
    const clone = Object.assign(Object.create(Object.getPrototypeOf(message)), message) as BaseMessage;
    clone.content =
      `${message.content.slice(0, maxChars)}\n\n` +
      `[Truncated ${dropped} chars — input exceeded ${maxChars} char budget. Answer from the visible excerpt.]`;
    return clone;
  });
}

function hasTerminalToolFailure(messages: BaseMessage[]): boolean {
  return messages.some(
    (m) => isToolMessage(m) && typeof m.content === "string" && isStructuredToolFailure(m.content),
  );
}

function filterToolsByLimits<T extends { name?: string }>(
  messages: BaseMessage[],
  tools: T[] | undefined,
  limits: Record<string, number> | undefined,
): T[] | undefined {
  if (!tools || !limits) return tools;
  return tools.filter((tool) => {
    const limit = limits[tool.name ?? ""];
    if (limit === undefined) return true;
    return countScheduledToolCalls(messages, tool.name ?? "") < limit;
  });
}

function toolLimitExceededMessage(toolName: string, limit: number, toolCallId: string): ToolMessage {
  return new ToolMessage({
    content:
      `${toolName} call limit (${limit}) reached for this turn. ` +
      "Synthesize your answer from prior tool results now — do not retry this tool.",
    tool_call_id: toolCallId,
  });
}

const countMsgTokens = (msgs: BaseMessage[]): number =>
  msgs.reduce((sum, m) => {
    const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    return sum + estimateTokens(text);
  }, 0);

async function trimHistory(
  rawMessages: BaseMessage[],
  maxTokens: number,
  preserveTaskAnchor = false,
): Promise<BaseMessage[]> {
  const historyOnly = rawMessages.filter((m) => !(m instanceof SystemMessage));

  // Task-anchor projection (roadmap #11): keep the first human message pinned so
  // the original task is never silently dropped by the rolling window. We reserve
  // its token cost, trim the REST to the remaining budget, then prepend it — but
  // only if it isn't already retained by the normal trim (short threads) and only
  // when it genuinely fits, so we never blow the budget to keep it.
  if (preserveTaskAnchor) {
    const firstHumanIdx = historyOnly.findIndex((m) => isHumanMessage(m));
    if (firstHumanIdx !== -1) {
      const anchor = historyOnly[firstHumanIdx]!;
      const anchorTokens = countMsgTokens([anchor]);
      const rest = historyOnly.filter((_, i) => i !== firstHumanIdx);
      const trimmedRest = await trimMessages(rest, {
        maxTokens: Math.max(0, maxTokens - anchorTokens),
        strategy: "last",
        tokenCounter: countMsgTokens,
        startOn: "human",
      });
      // If the trim already kept the anchor (short thread) don't duplicate it.
      const alreadyKept = trimmedRest.includes(anchor);
      const out = alreadyKept ? trimmedRest : [anchor, ...trimmedRest];
      return stripMessageNames(out);
    }
  }

  const trimmed = await trimMessages(historyOnly, {
    maxTokens,
    strategy: "last",
    tokenCounter: countMsgTokens,
    // Don't start on a partial exchange — keep full human/AI pairs.
    startOn: "human",
  });

  return stripMessageNames(trimmed);
}

function prepareMessages(
  rawMessages: BaseMessage[],
  opts: { maxTokens: number; maxMessageChars: number; preserveTaskAnchor?: boolean },
): Promise<BaseMessage[]> {
  const clamped = clampOversizedMessages(rawMessages, opts.maxMessageChars);
  return trimHistory(clamped, opts.maxTokens, opts.preserveTaskAnchor ?? false);
}

// ── Message modifier factory ───────────────────────────────────────────────────

/**
 * Create a MessageModifier that:
 *  1. Prepends the system prompt as a SystemMessage (always kept, never trimmed)
 *  2. Trims the history array to `maxTokens` keeping the most recent messages
 *     (strategy: "last" — same as Claude Code's rolling window)
 *
 * Accepts a string OR a zero-arg factory function. Pass a factory when the
 * prompt must stay fresh across a long-running process — e.g. buildCommsPrompt
 * and buildSupervisorPrompt inject today's date, so they must be re-evaluated
 * on every LLM call (not frozen at office compile time). Static prompts can
 * pass a plain string.
 *
 * Usage:
 *   const research = createReactAgent({
 *     llm, tools: [...], name: "research",
 *     prompt: createTrimmedPrompt(RESEARCH_PROMPT, { maxTokens: 4000 }),
 *   });
 *
 *   // Date-sensitive: pass the function reference, NOT the evaluated call:
 *   prompt: createTrimmedPrompt(buildCommsPrompt, subAgentBudget)
 */
export function createTrimmedPrompt(
  systemPromptText: string | (() => string),
  opts: TrimOptions = {},
): MessageModifier {
  const maxTokens = opts.maxTokens ?? 4000;
  const maxMessageChars = opts.maxMessageChars ?? DEFAULT_MAX_MESSAGE_CHARS;
  const preserveTaskAnchor = opts.preserveTaskAnchor ?? false;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async (input: any): Promise<BaseMessage[]> => {
    // Re-evaluate factory on every call so date-injected prompts stay current.
    const promptText =
      typeof systemPromptText === "function" ? systemPromptText() : systemPromptText;
    const systemMsg = new SystemMessage(promptText);

    // LangGraph 0.2.x passes the full state { messages: BaseMessage[] } at
    // runtime, even though the TypeScript type signature says BaseMessage[].
    // Unit tests pass an array directly. Handle both.
    const rawMessages: BaseMessage[] = Array.isArray(input) ? input : (input?.messages ?? []);

    const trimmed = await prepareMessages(rawMessages, { maxTokens, maxMessageChars, preserveTaskAnchor });

    return [systemMsg, ...trimmed];
  };
}

export function createAgentMiddleware(
  systemPromptText: string | (() => string),
  opts: TrimOptions = {},
): AnyAgentMiddleware[] {
  const maxTokens = opts.maxTokens ?? 4000;
  const maxMessageChars = opts.maxMessageChars ?? DEFAULT_MAX_MESSAGE_CHARS;
  const toolCallLimits = opts.toolCallLimits;
  const stopToolsAfterFailure = opts.stopToolsAfterFailure ?? false;
  const preserveTaskAnchor = opts.preserveTaskAnchor ?? false;

  return [
    dynamicSystemPromptMiddleware(() =>
      typeof systemPromptText === "function" ? systemPromptText() : systemPromptText,
    ),
    createMiddleware({
      name: "founderos_trim_messages",
      wrapModelCall: async (request, handler) => {
        const messages = await prepareMessages(request.messages, { maxTokens, maxMessageChars, preserveTaskAnchor });
        let tools = filterToolsByLimits(messages, request.tools, toolCallLimits) ?? request.tools;
        if (stopToolsAfterFailure && hasTerminalToolFailure(messages)) {
          tools = [];
        }
        return handler({ ...request, messages, tools });
      },
      wrapToolCall: async (request, handler) => {
        const toolName = request.toolCall.name;
        const limit = toolCallLimits?.[toolName];
        if (limit !== undefined) {
          const messages = request.state.messages ?? [];
          const completed = countCompletedToolCalls(messages, toolName);
          const pending = countPendingToolCalls(messages, toolName);
          if (completed >= limit || completed + pending > limit) {
            const toolCallId = request.toolCall.id;
            if (!toolCallId) {
              throw new Error(`Tool call ${toolName} is missing an id for limit enforcement.`);
            }
            return toolLimitExceededMessage(toolName, limit, toolCallId);
          }
        }
        return handler(request);
      },
    }),
  ];
}
