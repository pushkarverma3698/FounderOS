/**
 * FounderOS — token counts from a LangChain LLMResult
 * ===================================================
 * The one reading of "how many tokens did this call use" behind the run cap
 * (BudgetTracker) and the cost ledger (ai_call_costs, via the budget sink).
 *
 * WHERE THE NUMBERS ACTUALLY ARE (installed versions, checked 2026-09-28):
 *
 * - @langchain/google-genai 2.1.31, `.invoke()` — the path every kernel stage
 *   takes (planner/worker/synthesizer call `model.invoke`, and the graph is
 *   streamed with streamMode "values", which attaches no token-streaming
 *   handler). `llmOutput.tokenUsage` = { promptTokens, completionTokens,
 *   totalTokens } and `message.usage_metadata` = { input_tokens,
 *   output_tokens, total_tokens }. Output is `candidatesTokenCount` only;
 *   `thoughtsTokenCount` is dropped by the library (convertUsageMetadata,
 *   dist/utils/common.js:468-472) and survives only inside the total.
 * - @langchain/openai (OpenAI / OpenRouter): the same `tokenUsage` shape, where
 *   completion tokens already include any reasoning, so total − input equals
 *   the reported output and nothing changes.
 * - Anthropic: `llmOutput.usage` = { input_tokens, output_tokens }, no total.
 *
 * So output = the thought count when a result carries one (raw Gemini
 * `usage_metadata`), otherwise max(reported output, total − input). Gemini
 * bills thoughts at the output rate, so pricing needs no second rule.
 *
 * NOT covered, on purpose, because nothing in prod takes these paths today:
 * - A token-streamed Gemini call. @langchain/core 1.1.49 fills
 *   `llmOutput.tokenUsage` from the LAST chunk's usage delta
 *   (language_models/chat_models.js:185, 303), so every count here would be one
 *   chunk's worth. Streaming replies (deferred in the 2026-09-28 plan) must read
 *   the aggregated `message.usage_metadata` instead, or the ledger undercounts.
 * - ChatVertexAI (@langchain/google-common 2.3.0) puts LangChain-shaped
 *   `usage_metadata` (input_tokens/output_tokens, thoughts already included) in
 *   llmOutput and generationInfo, with no `tokenUsage` — so it records 0/0 here.
 */

import type { LLMResult } from "@langchain/core/outputs";

export interface TokenCounts {
  readonly inputTokens: number;
  /** Everything billed at the output rate, thought tokens included. */
  readonly outputTokens: number;
}

/** OpenAI-style (`promptTokens`) and Anthropic-style (`input_tokens`) llmOutput usage. */
type ReportedUsage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
};

/** Raw Gemini `usageMetadata` field names. */
type RawGeminiUsage = {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
};

export function tokenCountsOf(output: LLMResult): TokenCounts {
  const llmOut = output.llmOutput as Record<string, unknown> | undefined;
  const genInfo = output.generations?.[0]?.[0]?.generationInfo as Record<string, unknown> | undefined;
  const reported = (llmOut?.["tokenUsage"] ?? llmOut?.["usage"] ?? {}) as ReportedUsage;
  const raw = (genInfo?.["usage_metadata"] ?? llmOut?.["usage_metadata"] ?? {}) as RawGeminiUsage;

  const inputTokens = reported.promptTokens ?? reported.input_tokens ?? raw.promptTokenCount ?? 0;
  const visibleOutput = reported.completionTokens ?? reported.output_tokens ?? raw.candidatesTokenCount ?? 0;
  const total = reported.totalTokens ?? reported.total_tokens ?? raw.totalTokenCount;

  if (typeof raw.thoughtsTokenCount === "number") {
    // Explicit beats derived: a total can also hold toolUsePromptTokenCount.
    return { inputTokens, outputTokens: visibleOutput + raw.thoughtsTokenCount };
  }
  if (typeof total === "number") {
    return { inputTokens, outputTokens: Math.max(visibleOutput, total - inputTokens) };
  }
  return { inputTokens, outputTokens: visibleOutput };
}
