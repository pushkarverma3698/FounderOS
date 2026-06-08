/**
 * FounderOS — Office Invoke Guard
 * ================================
 * Pre-flight validation before every office.invoke() / resumeOffice() call.
 * Prevents "contents is not specified" 400 errors from Gemini when the
 * messages array is empty or the last message has no content — both of which
 * happen when history-window trimming removes all messages from the thread.
 */

import type { BaseMessage } from "@langchain/core/messages";

/**
 * Throws an informative error if the messages array is empty or the last
 * message has empty content. Call this before every office.invoke() and
 * resumeOffice() to eliminate Gemini 400 "contents is not specified" errors.
 */
export function assertNonEmptyMessages(messages: BaseMessage[], context: string): void {
  if (!messages || messages.length === 0) {
    throw new Error(`[${context}] Office invoked with empty messages array — Gemini requires at least one message`);
  }
  const last = messages[messages.length - 1]!;
  const content = typeof last.content === "string" ? last.content : JSON.stringify(last.content);
  if (!content || content.trim().length === 0) {
    throw new Error(`[${context}] Last message has empty content — Gemini rejects requests with blank message bodies`);
  }
}
