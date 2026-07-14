/**
 * FounderOS v3 kernel — tool-output guard (token protection).
 * ============================================================
 * Two deterministic, pure projections that stop tool payloads from burning
 * tokens in the worker loop:
 *
 *  1. clampToolOutput — a massive tool result (scraper JSON, DB dump) is
 *     truncated head+tail BEFORE it becomes a ToolMessage. The ToolReceipt
 *     digest is always computed from the FULL result at the call site, so
 *     ground truth is unchanged — only what the model re-reads is bounded.
 *  2. pruneScratchForModel — a read-time projection of a step's scratch for
 *     the NEXT model call: when the accumulated scratch exceeds its budget,
 *     the OLDEST tool results are collapsed to a stub (newest kept intact).
 *     The checkpointed scratch itself is never rewritten (append-only rule).
 *
 * Both keep the leading "❌"/failure markers intact so isFailureResult() and
 * the duplicate-failure guard still classify clamped results correctly.
 */

import { isToolMessage, type BaseMessage } from "@langchain/core/messages";
import { digestToolResult } from "./contracts.js";

/** Per-tool-result char cap (~3k tokens) — aligned with infra DEFAULT_MAX_MESSAGE_CHARS. */
export const TOOL_OUTPUT_MAX_CHARS = 12_000;
/** Tail kept on truncation so trailing JSON/errors stay visible. */
export const TOOL_OUTPUT_TAIL_CHARS = 1_000;
/** Total char budget for one step's scratch replayed to the model (~12k tokens). */
export const SCRATCH_MAX_CHARS = 48_000;
/** The newest N tool results are never pruned — the model needs its recent evidence. */
export const SCRATCH_KEEP_RECENT_TOOL_RESULTS = 2;

export const TOOL_OUTPUT_TRUNCATED_MARKER = "[[TOOL_OUTPUT_TRUNCATED";

/**
 * Bound one tool result to `maxChars`, preserving the head (failure markers,
 * summaries) and a tail slice (closing JSON, trailing errors). The marker
 * carries the dropped size + full-payload digest so the receipt stays
 * cross-checkable. Pure and idempotent for in-budget inputs.
 */
export function clampToolOutput(result: string, maxChars: number = TOOL_OUTPUT_MAX_CHARS): string {
  if (result.length <= maxChars) return result;
  // Reserve room for the marker line so the clamped string itself fits the
  // budget — which also makes the clamp idempotent (re-clamping is a no-op).
  const markerReserve = 200;
  const tail = Math.min(TOOL_OUTPUT_TAIL_CHARS, Math.floor(maxChars / 4));
  const head = Math.max(1, maxChars - tail - markerReserve);
  const dropped = result.length - head - tail;
  const digest = digestToolResult(result).slice(0, 12);
  return (
    result.slice(0, head) +
    `\n… ${TOOL_OUTPUT_TRUNCATED_MARKER} dropped=${dropped} chars of ${result.length} total, sha256=${digest}]] ` +
    `Work from the visible excerpt — do NOT re-call the tool to see the rest.\n` +
    result.slice(result.length - tail)
  );
}

function contentChars(message: BaseMessage): number {
  return typeof message.content === "string" ? message.content.length : JSON.stringify(message.content).length;
}

function withStubContent(message: BaseMessage): BaseMessage {
  const clone = Object.assign(Object.create(Object.getPrototypeOf(message)), message) as BaseMessage;
  const original = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
  const failed = original.trimStart().startsWith("❌");
  clone.content =
    `[earlier tool result pruned to save context — ${original.length} chars, ` +
    `outcome=${failed ? "FAILED" : "ok"}, sha256=${digestToolResult(original).slice(0, 12)}. ` +
    `Its findings are reflected in the conversation after it.]`;
  return clone;
}

/**
 * Project a step's scratch down to the char budget for the next model call.
 * Only ToolMessage content is collapsed (AI messages carry the tool_calls the
 * provider needs for pairing, and human/system frames are small); newest
 * results and everything already under budget pass through untouched.
 */
export function pruneScratchForModel(
  scratch: BaseMessage[],
  maxChars: number = SCRATCH_MAX_CHARS,
): BaseMessage[] {
  let total = scratch.reduce((n, m) => n + contentChars(m), 0);
  if (total <= maxChars) return scratch;

  const toolIndexes = scratch
    .map((m, i) => (isToolMessage(m) ? i : -1))
    .filter((i) => i !== -1);
  const prunable = toolIndexes.slice(0, Math.max(0, toolIndexes.length - SCRATCH_KEEP_RECENT_TOOL_RESULTS));

  const out = [...scratch];
  for (const idx of prunable) {
    if (total <= maxChars) break;
    const before = contentChars(out[idx]!);
    out[idx] = withStubContent(out[idx]!);
    total += contentChars(out[idx]!) - before;
  }
  return out;
}
