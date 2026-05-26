/**
 * FounderOS — Context Manager
 * ============================
 * Manages what goes into an LLM's context window.
 *
 * Problems it solves:
 *  1. Message history overflow — old messages push out important recent context
 *  2. State bloat — serializing full pod state wastes tokens on irrelevant fields
 *  3. System prompt assembly — building a consistent, compact system message
 *
 * All functions are pure (no LLM calls, no DB reads).
 * Apply these BEFORE calling callCascade() in any agent node.
 */

import type { CoreMessage } from "ai";
import { estimateTokens, truncateToTokenBudget } from "./token-optimizer.js";

// ── Message history trimming ───────────────────────────────────────────────────

export interface TrimOptions {
  /** Hard token budget for the entire message array. */
  maxTokens: number;
  /** Always keep this many recent messages regardless of budget. Default: 4. */
  keepRecent?: number;
  /** Always keep the first message (usually the initial task). Default: true. */
  keepFirst?: boolean;
}

/**
 * Trim a message history to fit within a token budget.
 * Strategy: always keep the last N messages + optionally the first message,
 * drop the middle.
 *
 * This is the "sliding window" pattern — common in production chatbots.
 * It preserves task framing (first message) + most recent state (last N).
 *
 * @example
 *   const trimmed = trimMessageHistory(state.messages, {
 *     maxTokens: 2000,
 *     keepRecent: 6,
 *   });
 */
export function trimMessageHistory(
  messages: CoreMessage[],
  opts: TrimOptions,
): CoreMessage[] {
  const keepRecent = opts.keepRecent ?? 4;
  const keepFirst = opts.keepFirst !== false;

  if (messages.length === 0) return [];

  // Cheap path: already fits
  const totalTokens = messages.reduce(
    (sum, m) => sum + estimateTokens(typeof m.content === "string" ? m.content : JSON.stringify(m.content)),
    0,
  );
  if (totalTokens <= opts.maxTokens) return messages;

  // Separate: first message, recent tail, middle
  const [first, ...rest] = messages;
  const recent = rest.slice(-keepRecent);
  const middle = rest.slice(0, rest.length - keepRecent);

  // Build from recent backwards; add first if room
  const result: CoreMessage[] = [...recent];
  let usedTokens = result.reduce(
    (sum, m) => sum + estimateTokens(typeof m.content === "string" ? m.content : JSON.stringify(m.content)),
    0,
  );

  // Try to include middle messages (oldest first, within budget)
  for (const msg of [...middle].reverse()) {
    const cost = estimateTokens(typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content));
    if (usedTokens + cost <= opts.maxTokens * 0.7) {
      result.unshift(msg);
      usedTokens += cost;
    }
  }

  // Add first message if requested and budget allows
  if (keepFirst && first) {
    const firstCost = estimateTokens(
      typeof first.content === "string" ? first.content : JSON.stringify(first.content),
    );
    if (usedTokens + firstCost <= opts.maxTokens) {
      result.unshift(first);
    }
  }

  return result;
}

// ── Compact system context builder ────────────────────────────────────────────

export interface SystemContextOpts {
  /** Company readable name or profile summary. */
  companyContext: string;
  /** What the current agent must do (1–3 sentences). */
  agentRole: string;
  /** Optional hard rules (will be rendered as a numbered list). */
  rules?: string[];
  /** Target output format instruction. */
  outputFormat?: string;
  /** Max tokens for the full system message. Default: 400. */
  maxTokens?: number;
}

/**
 * Build a compact, structured system message.
 * Avoids the common trap of 1000+ token system prompts full of boilerplate.
 *
 * A 200–400 token system prompt leaves significantly more room for
 * the actual task content where the quality leverage is.
 */
export function buildSystemContext(opts: SystemContextOpts): string {
  const maxTokens = opts.maxTokens ?? 400;
  const parts: string[] = [];

  parts.push(`Company: ${opts.companyContext}`);
  parts.push(`Role: ${opts.agentRole}`);

  if (opts.rules && opts.rules.length > 0) {
    parts.push(`Rules:\n${opts.rules.map((r, i) => `${i + 1}. ${r}`).join("\n")}`);
  }

  if (opts.outputFormat) {
    parts.push(`Output: ${opts.outputFormat}`);
  }

  const raw = parts.join("\n\n");
  return truncateToTokenBudget(raw, maxTokens, "end");
}

// ── Priority-based state serializer ──────────────────────────────────────────

export interface FieldPriority<T> {
  key: keyof T;
  /** Higher = more important. Priority 3+ always included if non-empty. */
  priority: 1 | 2 | 3;
  /** Token budget for this field. Default: 200. */
  maxTokens?: number;
  /** Transform before serializing (e.g. take only last element). */
  transform?: (value: unknown) => unknown;
}

/**
 * Serialize a subset of state fields for prompt injection.
 * Fields with priority 3 are always included (critical context).
 * Fields with priority 2 are included if budget allows.
 * Fields with priority 1 are included only if budget still permits.
 *
 * @example
 *   const context = serializeStateForPrompt(state, [
 *     { key: "intel_report", priority: 3, maxTokens: 500 },
 *     { key: "lead",         priority: 3, maxTokens: 200 },
 *     { key: "critiques",    priority: 2, maxTokens: 200,
 *       transform: (v) => (v as CritiqueRecord[]).at(-1) },
 *   ], { totalMaxTokens: 900 });
 */
export function serializeStateForPrompt<T extends Record<string, unknown>>(
  state: T,
  fields: FieldPriority<T>[],
  opts: { totalMaxTokens: number },
): string {
  // Sort by priority descending
  const sorted = [...fields].sort((a, b) => b.priority - a.priority);
  const parts: string[] = [];
  let usedTokens = 0;

  for (const field of sorted) {
    const rawValue = state[field.key];
    if (rawValue === null || rawValue === undefined || rawValue === "") continue;

    const value = field.transform ? field.transform(rawValue) : rawValue;
    const fieldMaxTokens = field.maxTokens ?? 200;

    const serialized = typeof value === "string" ? value : JSON.stringify(value, null, 2);

    const truncated = truncateToTokenBudget(serialized, fieldMaxTokens, "sentences");
    const cost = estimateTokens(truncated);

    // Priority 3: always include (critical fields)
    // Priority 2 & 1: include only if budget allows
    if (field.priority === 3 || usedTokens + cost <= opts.totalMaxTokens * 0.85) {
      parts.push(`### ${String(field.key)}\n${truncated}`);
      usedTokens += cost;
    }

    if (usedTokens >= opts.totalMaxTokens) break;
  }

  return parts.join("\n\n");
}

// ── Prompt token budget calculator ────────────────────────────────────────────

export interface PromptBudget {
  /** Tokens available for the system message. */
  system: number;
  /** Tokens available for the message history. */
  history: number;
  /** Tokens available for the user task / context injection. */
  task: number;
  /** Tokens reserved for the model's response. */
  response: number;
  /** Total context window. */
  total: number;
}

/**
 * Compute a balanced token budget for each part of the prompt.
 * Prevents any single part from dominating the context window.
 *
 * @param contextWindow  Total token limit for the model (e.g. 32000)
 * @param responseBudget How many tokens to reserve for the response
 */
export function computePromptBudget(
  contextWindow: number,
  responseBudget = 2048,
): PromptBudget {
  const available = contextWindow - responseBudget;
  return {
    system:   Math.floor(available * 0.10), // 10% — keep prompts tight
    history:  Math.floor(available * 0.25), // 25% — recent conversation
    task:     Math.floor(available * 0.65), // 65% — task + context (where value is)
    response: responseBudget,
    total:    contextWindow,
  };
}
