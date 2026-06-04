/**
 * FounderOS — Conversation Recorder
 * ===================================
 * Called after each Telegram office.invoke() completes to persist a searchable
 * record of the conversation in the `conversations` table.
 *
 * What it does:
 *   1. Skips if no messages (no-op on empty runs).
 *   2. Extracts a summary: first 500 chars of the last AI text message.
 *   3. Extracts 3–5 topic tags: pure deterministic keyword extraction from the
 *      combined message text (no LLM cost — fast and free).
 *   4. Upserts the `conversations` row for this thread_id.
 *
 * Why no Ollama call for summarisation:
 *   Ollama is unavailable in CI and costs a round-trip for marginal benefit.
 *   The last AI message IS the summary — it already says what was done.
 *   We keep the option open: if `OLLAMA_SUMMARISE=1` is set in env we can
 *   swap in an Ollama call later without changing the interface.
 *
 * Caller: src/gateway/telegram.ts — after every successful runOfficeText().
 */

import { upsertConversation } from "../db/queries.js";
import { childLogger } from "../infra/logger.js";

const log = childLogger({ module: "conversation-recorder" });

const TENANT = process.env["FOUNDER_TENANT"] ?? "turicks";

// ── Types ─────────────────────────────────────────────────────────────────────

interface RecordableMessage {
  content: unknown;
  _getType?: () => string;
  tool_calls?: unknown[];
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Pull the last AI text message from the run's message list.
 * Returns empty string if no qualifying message exists.
 */
function extractLastAiText(messages: RecordableMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    const type = m._getType?.() ?? "";
    const text = typeof m.content === "string" ? m.content : "";
    // Skip tool-call-only messages and non-ai types
    if (type === "ai" && text.trim() && !(m.tool_calls && m.tool_calls.length > 0)) {
      return text.trim();
    }
  }
  return "";
}

/**
 * Extract 3–5 topic tags from combined message text.
 * Deterministic: no LLM. Finds the N most-frequent meaningful words (≥5 chars)
 * that are not stop words. Lowercased and de-duplicated.
 */
const STOP_WORDS = new Set([
  "about", "after", "again", "also", "always", "because", "before", "between",
  "could", "doing", "during", "every", "first", "found", "great", "happening",
  "have", "hello", "here", "just", "know", "like", "make", "more", "much",
  "need", "other", "over", "please", "really", "right", "should", "since",
  "some", "still", "that", "their", "there", "these", "they", "think", "this",
  "through", "time", "under", "until", "update", "using", "want", "well",
  "were", "what", "when", "where", "which", "while", "will", "with", "would",
  "your",
]);

export function extractTopics(text: string, maxTopics = 5): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 5 && !STOP_WORDS.has(w));

  const freq = new Map<string, number>();
  for (const w of words) {
    freq.set(w, (freq.get(w) ?? 0) + 1);
  }

  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxTopics)
    .map(([w]) => w);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Persist a searchable summary of this conversation run.
 * Safe to call fire-and-forget — errors are logged, not thrown.
 *
 * @param threadId  LangGraph thread_id (format: "turicks:{chatId}")
 * @param messages  The message list from the office invoke() result
 */
export async function recordConversationEnd(
  threadId: string,
  messages: RecordableMessage[],
): Promise<void> {
  if (messages.length === 0) return;

  try {
    const lastText = extractLastAiText(messages);

    // Combine all text for topic extraction
    const allText = messages
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join(" ");

    const summary = lastText.slice(0, 500) || "(no text reply)";
    const topics = extractTopics(allText);

    await upsertConversation({
      thread_id: threadId,
      tenant_id: TENANT,
      last_message_at: new Date(),
      summary,
      topics,
      message_count: messages.length,
    });

    log.debug({ threadId, topicsCount: topics.length }, "Conversation recorded");
  } catch (err) {
    // Non-fatal — never let recording failures break the Telegram response
    log.warn({ err: (err as Error).message, threadId }, "Failed to record conversation");
  }
}
