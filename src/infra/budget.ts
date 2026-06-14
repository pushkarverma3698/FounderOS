/**
 * FounderOS — Budget Guard
 * ========================
 * Per-run token and dollar cost caps. Prevents runaway LLM spend on a single
 * agentic workflow. Pure, side-effect-free functions so the guard is testable
 * and can be extracted as a standalone npm package.
 *
 * Usage:
 *   const tracker = new BudgetTracker({ maxUsd: 0.50, maxTokens: 50_000 });
 *   tracker.accrue(inputTokens, outputTokens, modelId);
 *   const check = tracker.check();
 *   if (!check.ok) throw new BudgetExceededError(check.reason);
 *
 * Wire the tracker into an office invoke via BudgetGuardCallback (LangChain callback):
 *   await office.invoke(input, { callbacks: [new BudgetGuardCallback(tracker)] });
 *
 * Pricing source: https://ai.google.dev/pricing (June 2026)
 *                 https://www.anthropic.com/pricing (June 2026)
 */

import type { LLMResult } from "@langchain/core/outputs";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";

// ── Model pricing table ───────────────────────────────────────────────────────

/** Cost per million tokens (USD). */
export interface ModelCost {
  inputPerM: number;
  outputPerM: number;
}

/**
 * Per-model pricing table. Covers the FounderOS model cascade.
 * Update prices here when providers change rates.
 */
export const MODEL_COSTS: Record<string, ModelCost> = {
  // Google Gemini
  "gemini-2.5-flash":                 { inputPerM: 0.075,  outputPerM: 0.30 },
  "gemini-2.5-flash-preview-05-20":   { inputPerM: 0.075,  outputPerM: 0.30 },
  "gemini-2.5-flash-lite":            { inputPerM: 0.0375, outputPerM: 0.15 },
  "gemini-2.5-pro":                   { inputPerM: 1.25,   outputPerM: 10.0 },
  "gemini-1.5-flash":                 { inputPerM: 0.075,  outputPerM: 0.30 },
  // Anthropic Claude
  "claude-sonnet-4-5":                { inputPerM: 3.0,    outputPerM: 15.0 },
  "claude-sonnet-4-6":                { inputPerM: 3.0,    outputPerM: 15.0 },
  "claude-haiku-4-5":                 { inputPerM: 0.25,   outputPerM: 1.25 },
  "claude-opus-4-8":                  { inputPerM: 15.0,   outputPerM: 75.0 },
  // OpenRouter free-tier (approx)
  "deepseek-r1:free":                 { inputPerM: 0.0,    outputPerM: 0.0  },
  "meta-llama/llama-3.3-70b-instruct:free": { inputPerM: 0.0, outputPerM: 0.0 },
  "qwen3-coder:free":                 { inputPerM: 0.0,    outputPerM: 0.0  },
};

/** Safe default for unlisted models (pessimistic estimate). */
const DEFAULT_COST: ModelCost = { inputPerM: 0.10, outputPerM: 0.50 };

// ── Pure cost estimator ───────────────────────────────────────────────────────

/**
 * Calculate the estimated cost of a single LLM call.
 * Pure function — no I/O, no side effects.
 */
export function estimateCost(inputTokens: number, outputTokens: number, modelId: string): number {
  const costs = MODEL_COSTS[modelId] ?? DEFAULT_COST;
  return (inputTokens * costs.inputPerM + outputTokens * costs.outputPerM) / 1_000_000;
}

// ── BudgetTracker ─────────────────────────────────────────────────────────────

export interface BudgetCaps {
  maxUsd: number;
  maxTokens: number;
}

export type BudgetCheckResult = { ok: true } | { ok: false; reason: string };

/**
 * Accumulates token and dollar cost across multiple LLM calls in a single run.
 * Call accrue() after each call, then check() to see if the budget is blown.
 */
export class BudgetTracker {
  private _totalUsd = 0;
  private _totalTokens = 0;
  private _totalInputTokens = 0;
  private _totalOutputTokens = 0;

  constructor(private readonly caps: BudgetCaps) {}

  /** Accrue cost for one LLM call. */
  accrue(inputTokens: number, outputTokens: number, modelId: string): void {
    this._totalInputTokens += inputTokens;
    this._totalOutputTokens += outputTokens;
    this._totalTokens += inputTokens + outputTokens;
    this._totalUsd += estimateCost(inputTokens, outputTokens, modelId);
  }

  /**
   * Check whether the accumulated cost is within caps.
   * Returns { ok: true } if safe, { ok: false, reason } if the budget is blown.
   */
  check(): BudgetCheckResult {
    if (this._totalUsd >= this.caps.maxUsd) {
      return {
        ok: false,
        reason:
          `Budget exceeded: $${this._totalUsd.toFixed(4)} ≥ $${this.caps.maxUsd.toFixed(4)} limit per run. ` +
          `Set RUN_BUDGET_USD in .env to raise the cap.`,
      };
    }
    if (this._totalTokens >= this.caps.maxTokens) {
      return {
        ok: false,
        reason:
          `Token budget exceeded: ${this._totalTokens.toLocaleString()} ≥ ` +
          `${this.caps.maxTokens.toLocaleString()} token limit per run. ` +
          `Set RUN_BUDGET_TOKENS in .env to raise the cap.`,
      };
    }
    return { ok: true };
  }

  get summary(): {
    totalUsd: number;
    totalTokens: number;
    totalInputTokens: number;
    totalOutputTokens: number;
  } {
    return {
      totalUsd: this._totalUsd,
      totalTokens: this._totalTokens,
      totalInputTokens: this._totalInputTokens,
      totalOutputTokens: this._totalOutputTokens,
    };
  }
}

// ── BudgetExceededError ───────────────────────────────────────────────────────

/** Thrown when a BudgetTracker check fails. Caught at the gateway to surface to Telegram. */
export class BudgetExceededError extends Error {
  constructor(public readonly reason: string) {
    super(`BudgetExceededError: ${reason}`);
    this.name = "BudgetExceededError";
  }
}

// ── LangChain callback integration ───────────────────────────────────────────

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
  ) {
    super();
  }

  override async handleLLMEnd(output: LLMResult): Promise<void> {
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

    this.tracker.accrue(inputTokens, outputTokens, this.modelId);

    const check = this.tracker.check();
    if (!check.ok) {
      throw new BudgetExceededError(check.reason);
    }
  }
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
