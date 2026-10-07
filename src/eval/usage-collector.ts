/**
 * Captures every LLM call of an eval turn: stage, actor, answering model, tokens.
 *
 * It is the production cost-ledger callback (BudgetGuardCallback) with a recording
 * sink and no spend cap, so the model name and token counts are read exactly the
 * way ai_call_costs rows are, including the response-reported model name and the
 * thought-token rule. The A/B table and the ledger therefore cannot disagree.
 *
 * LangChain runs callback handlers on a background queue, so take() waits for the
 * queue to drain before it hands the calls over.
 */

import { awaitAllCallbacks } from "@langchain/core/callbacks/promises";
import { BudgetGuardCallback, BudgetTracker, UNATTRIBUTED_AGENT, UNATTRIBUTED_STAGE } from "../infra/budget.js";
import type { LlmCallUsage } from "./types.js";

/** What the kernel invoker needs from a collector (a test double can satisfy it). */
export interface UsageSource {
  readonly callback: BudgetGuardCallback;
  /** The calls made since the last take(), after pending callbacks have settled. */
  take(): Promise<LlmCallUsage[]>;
}

/** Recorded when neither the response nor the stage names the answering model. */
const UNKNOWN_MODEL = "unknown";

export function makeUsageCollector(): UsageSource {
  const calls: LlmCallUsage[] = [];
  // Infinity caps: tracker.check() never fails, so the callback never signals a breach.
  const tracker = new BudgetTracker({ maxUsd: Number.POSITIVE_INFINITY, maxTokens: Number.POSITIVE_INFINITY });
  const callback = new BudgetGuardCallback(tracker, UNKNOWN_MODEL, (c) => {
    calls.push({
      stage: c.attribution?.stage ?? UNATTRIBUTED_STAGE,
      agent: c.attribution?.agent ?? UNATTRIBUTED_AGENT,
      model: c.model,
      inputTokens: c.inputTokens,
      outputTokens: c.outputTokens,
    });
  });
  return {
    callback,
    take: async () => {
      await awaitAllCallbacks();
      return calls.splice(0);
    },
  };
}
