/**
 * FounderOS — Budget Guard: the LangChain-facing half
 * ===================================================
 * Per-run token and dollar caps, wired to the framework. The pure pieces
 * (pricing, attribution, BudgetTracker, BudgetExceededError) live in
 * budget-costs.ts and are re-exported below, so this module is the single
 * import for every caller and the split is invisible outside these two files.
 *
 * Usage:
 *   const budget = enforceRunBudget(AGENT_MODEL, costSink);
 *   await graph.stream(input, { callbacks: [budget.callback], signal: budget.signal });
 *   // in catch: const failure = budget.breachError() ?? err;
 *
 * READ enforceRunBudget's docblock before reaching for the callback alone: a
 * throw from a callback handler is swallowed by LangChain, so the callback on
 * its own accrues cost and stops nothing.
 */

import type { LLMResult } from "@langchain/core/outputs";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";

import {
  BudgetTracker,
  BudgetExceededError,
  estimateCost,
  attributionFromMetadata,
  type CostAttribution,
} from "./budget-costs.js";

export * from "./budget-costs.js";

// ── LangChain callback integration ───────────────────────────────────────────

/** One accrued LLM call, as handed to the per-call sink. */
export interface AccruedCall {
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly usd: number;
  /**
   * Who spent it. Undefined when the call carried no attribution metadata; the
   * sink records that as unattributed rather than guessing, otherwise one stage
   * silently absorbs another's spend.
   */
  readonly attribution?: CostAttribution;
}

/**
 * LangChain callback handler that accrues cost after each LLM call and throws
 * BudgetExceededError if the cap is breached. Attach to an office.invoke() call:
 *
 *   await office.invoke(input, {
 *     configurable: { thread_id },
 *     callbacks: [new BudgetGuardCallback(tracker, modelId)],
 *   });
 */
export class BudgetGuardCallback extends BaseCallbackHandler {
  name = "BudgetGuardCallback";

  constructor(
    private readonly tracker: BudgetTracker,
    private readonly modelId: string = "gemini-2.5-flash",
    /**
     * Per-call sink, invoked after accrual and BEFORE the cap check (a call
     * that blows the budget still belongs on the ledger). Wire it to persist
     * rows into ai_call_costs — the daily budget cap and the cost ledger read
     * that table, so leaving this unset makes both blind. Must not throw.
     */
    private readonly onAccrue?: (call: AccruedCall) => void,
    /**
     * Invoked ONCE, the first time the cap is breached, before the throw below.
     *
     * The throw is not the guard and never was. LangChain's callback manager
     * catches whatever a handler throws and logs it ("Error in handler
     * BudgetGuardCallback, handleLLMEnd: …" — the literal line in the
     * 2026-09-07 journal), so it cannot abort `.invoke()`. This hook is how a
     * breach reaches a mechanism the framework does honour: see
     * `enforceRunBudget`, which wires it to an AbortController. Must not throw.
     */
    private readonly onBreach?: (reason: string) => void,
  ) {
    super();
  }

  /** First breach only — a later call must not rewrite why the run stopped. */
  private breachReported = false;

  /**
   * Started-but-not-ended runs, keyed by the runId LangChain passes to BOTH the
   * start and end hooks as a direct argument. Cleared on end and on error; the
   * handler is per-run, so an aborted call cannot leak past its turn.
   */
  private readonly pendingAttribution = new Map<string, CostAttribution>();

  private rememberAttribution(runId: string, metadata?: Record<string, unknown>): void {
    const attribution = attributionFromMetadata(metadata);
    if (attribution) this.pendingAttribution.set(runId, attribution);
  }

  /** Chat models dispatch here; LangChain falls back to handleLLMStart if absent. */
  override async handleChatModelStart(
    _llm: unknown, _messages: unknown, runId: string, _parentRunId?: string,
    _extraParams?: Record<string, unknown>, _tags?: string[], metadata?: Record<string, unknown>,
  ): Promise<void> {
    this.rememberAttribution(runId, metadata);
  }

  override async handleLLMStart(
    _llm: unknown, _prompts: string[], runId: string, _parentRunId?: string,
    _extraParams?: Record<string, unknown>, _tags?: string[], metadata?: Record<string, unknown>,
  ): Promise<void> {
    this.rememberAttribution(runId, metadata);
  }

  /** A failed call never reaches handleLLMEnd — drop its entry so the map cannot grow. */
  override async handleLLMError(_err: unknown, runId: string): Promise<void> {
    this.pendingAttribution.delete(runId);
  }

  override async handleLLMEnd(output: LLMResult, runId?: string): Promise<void> {
    // Extract token usage from multiple possible locations in the LangChain output.
    // Gemini puts it in llmOutput.usage or in generation[0].generationInfo.usage_metadata.
    const llmOut = output.llmOutput as Record<string, unknown> | undefined;
    const genInfo = output.generations?.[0]?.[0]?.generationInfo as Record<string, unknown> | undefined;

    // Try llmOutput.tokenUsage (standard OpenAI-style), then Gemini-specific paths.
    type TokenUsage = { promptTokens?: number; completionTokens?: number; input_tokens?: number; output_tokens?: number };
    type GeminiUsage = { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };

    const tokenUsage = (llmOut?.["tokenUsage"] ?? llmOut?.["usage"] ?? {}) as TokenUsage;
    const usageMeta = (genInfo?.["usage_metadata"] ?? llmOut?.["usage_metadata"] ?? {}) as GeminiUsage;

    const inputTokens =
      tokenUsage.promptTokens ??
      tokenUsage.input_tokens ??
      usageMeta.promptTokenCount ??
      0;

    const outputTokens =
      tokenUsage.completionTokens ??
      tokenUsage.output_tokens ??
      usageMeta.candidatesTokenCount ??
      0;

    // G6: use the actual model from the response when available — handles the
    // fallback model case where AGENT_MODEL ≠ what was actually called. The
    // model field location varies by provider (OpenAI, Gemini, Anthropic).
    const actualModel =
      (genInfo?.["model"] as string | undefined) ??
      (llmOut?.["model_id"] as string | undefined) ??
      (llmOut?.["model"] as string | undefined) ??
      this.modelId;

    // Correlated by runId, NOT by async context — see COST_AGENT_METADATA_KEY.
    const attribution = runId === undefined ? undefined : this.pendingAttribution.get(runId);
    if (runId !== undefined) this.pendingAttribution.delete(runId);

    this.tracker.accrue(inputTokens, outputTokens, actualModel);
    this.onAccrue?.({
      model: actualModel,
      inputTokens,
      outputTokens,
      usd: estimateCost(inputTokens, outputTokens, actualModel),
      attribution,
    });

    const check = this.tracker.check();
    if (!check.ok) {
      if (!this.breachReported) {
        this.breachReported = true;
        this.onBreach?.(check.reason);
      }
      // Kept for the direct-invoke callers (worker-invoke.ts, live-e2e-proof.ts)
      // that DO see it. Through LangChain's manager it is swallowed — which is
      // exactly why onBreach above exists and runs first.
      throw new BudgetExceededError(check.reason);
    }
  }
}

// ── Run enforcement (the part LangChain cannot swallow) ───────────────────────

/**
 * A run budget wired to an AbortSignal.
 *
 * `signal` goes to whatever runs the graph; `breachError()` re-types the
 * resulting generic AbortError back into the founder-facing budget message.
 * Aborting is the same mechanism the turn timeout already uses, and unlike a
 * thrown callback it is one the framework honours.
 */
export interface RunBudgetEnforcement {
  readonly callback: BudgetGuardCallback;
  readonly signal: AbortSignal;
  /** True once the caps were breached (not merely aborted for another reason). */
  readonly breached: boolean;
  /** Abort for a reason that is NOT the budget — a turn timeout. Leaves `breached` false. */
  abort(): void;
  /** The typed error to report, or undefined when the budget is not why this run stopped. */
  breachError(): BudgetExceededError | undefined;
}

/**
 * Build a budget guard that can actually stop the run it is attached to.
 *
 *   const budget = enforceRunBudget(AGENT_MODEL, kernelCostSink);
 *   await graph.stream(input, { callbacks: [budget.callback], signal: budget.signal });
 *   // in catch: const failure = budget.breachError() ?? err;
 */
export function enforceRunBudget(
  modelId: string,
  onAccrue?: (call: AccruedCall) => void,
  tracker: BudgetTracker = createRunBudget(),
): RunBudgetEnforcement {
  const controller = new AbortController();
  let reason: string | undefined;

  const callback = new BudgetGuardCallback(tracker, modelId, onAccrue, (why) => {
    reason = why;
    controller.abort();
  });

  return {
    callback,
    signal: controller.signal,
    get breached() {
      return reason !== undefined;
    },
    abort: () => controller.abort(),
    breachError: () => (reason === undefined ? undefined : new BudgetExceededError(reason)),
  };
}

// ── Budget factory ────────────────────────────────────────────────────────────

/**
 * Create a BudgetTracker from environment variables.
 * RUN_BUDGET_USD    — max $ per run (default: 0.50)
 * RUN_BUDGET_TOKENS — max tokens per run (default: 50,000)
 */
export function createRunBudget(): BudgetTracker {
  const maxUsd = Number.parseFloat(process.env["RUN_BUDGET_USD"] ?? "0.50");
  const maxTokens = Number.parseInt(process.env["RUN_BUDGET_TOKENS"] ?? "50000", 10);
  return new BudgetTracker({
    maxUsd: Number.isFinite(maxUsd) && maxUsd > 0 ? maxUsd : 0.50,
    maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 50_000,
  });
}

