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

import { trimMessages, SystemMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { createMiddleware, dynamicSystemPromptMiddleware } from "langchain";
import type { AnyAgentMiddleware } from "langchain";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TrimOptions {
  /** Token budget for history (excluding system message). Default: 4000. */
  maxTokens?: number;
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

async function trimHistory(rawMessages: BaseMessage[], maxTokens: number): Promise<BaseMessage[]> {
  const historyOnly = rawMessages.filter((m) => !(m instanceof SystemMessage));
  const trimmed = await trimMessages(historyOnly, {
    maxTokens,
    strategy: "last",
    tokenCounter: (msgs) =>
      msgs.reduce((sum, m) => {
        const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        return sum + estimateTokens(text);
      }, 0),
    // Don't start on a partial exchange — keep full human/AI pairs.
    startOn: "human",
  });

  return stripMessageNames(trimmed);
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

    const trimmed = await trimHistory(rawMessages, maxTokens);

    return [systemMsg, ...trimmed];
  };
}

export function createAgentMiddleware(
  systemPromptText: string | (() => string),
  opts: TrimOptions = {},
): AnyAgentMiddleware[] {
  const maxTokens = opts.maxTokens ?? 4000;

  return [
    dynamicSystemPromptMiddleware(() =>
      typeof systemPromptText === "function" ? systemPromptText() : systemPromptText,
    ),
    createMiddleware({
      name: "founderos_trim_messages",
      wrapModelCall: async (request, handler) => {
        const messages = await trimHistory(request.messages, maxTokens);
        return handler({ ...request, messages });
      },
    }),
  ];
}
