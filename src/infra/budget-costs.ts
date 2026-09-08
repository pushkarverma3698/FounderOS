/**
 * FounderOS — Budget Guard: pricing, attribution and the run tracker
 * ==================================================================
 * The PURE half of the budget guard — no LangChain, no side effects, no clock.
 * Split out of budget.ts on 2026-09-08 when the run-enforcement work pushed
 * that file past the 400-line fitness budget (scripts/verify-architecture.ts).
 * The split is along the seam the file already had: everything here is a
 * function of its arguments, everything in budget.ts touches the framework.
 *
 * `budget.ts` re-exports all of this, so every existing
 * `from "../infra/budget.js"` import keeps working and nothing imports this
 * file directly. The dependency runs one way — budget.ts → budget-costs.ts —
 * deliberately, so there is no cycle to reason about at module-eval time.
 *
 * Pricing source: https://ai.google.dev/pricing (June 2026)
 *                 https://www.anthropic.com/pricing (June 2026)
 */

// ── Cost attribution ──────────────────────────────────────────────────────────

/** The kernel node that spent the money. Persisted to ai_call_costs.tier. */
export type CostStage = "planner" | "worker" | "synthesizer";

/**
 * Who spent one LLM call. `agent` is the ACTOR — a worker id ("jobhunt",
 * "research", …) when the model was bound to that worker's tools, else the
 * stage-level actor — matching the convention gap-scan-budget.ts ("research")
 * and creative.ts ("creative") already write. `stage` is the kernel node.
 * Persisted to ai_call_costs.agent and .tier respectively.
 */
export interface CostAttribution {
  readonly agent: string;
  readonly stage: CostStage;
}

/**
 * Actor recorded when a call carries no attribution — an LLM call the
 * kernel-boot model wrappers did not wrap. Deliberately NOT a real worker id, so
 * the gap stays visible in the ledger instead of being absorbed by a real spender.
 */
export const UNATTRIBUTED_AGENT = "kernel";
/** Stage recorded for the same case. */
export const UNATTRIBUTED_STAGE = "unattributed";

/**
 * Run-metadata keys the attribution travels under, correlated to an accrual by
 * runId. It must ride on the call as DATA: @langchain/core queues callback
 * handlers on a shared p-queue unless LANGCHAIN_CALLBACKS_BACKGROUND === "false"
 * (unset here), so handlers run detached from the caller's async context and an
 * AsyncLocalStorage identity reads back wrong for every CONCURRENT call —
 * silently, with nothing flagged. Full rationale and the regression that proves
 * it: tests/unit/gateway/cost-attribution.test.ts, "attribution under REAL
 * LangChain callback dispatch".
 */
export const COST_AGENT_METADATA_KEY = "cost_agent";
/** @see COST_AGENT_METADATA_KEY */
export const COST_STAGE_METADATA_KEY = "cost_stage";

/** The three kernel nodes that can spend. Anything else is not a stage we wrote. */
const COST_STAGES: readonly string[] = ["planner", "worker", "synthesizer"];
const isCostStage = (value: unknown): value is CostStage =>
  typeof value === "string" && COST_STAGES.includes(value);

/** Render an attribution as run metadata for a model invoke config. */
export function costAttributionMetadata(attribution: CostAttribution): Record<string, string> {
  return { [COST_AGENT_METADATA_KEY]: attribution.agent, [COST_STAGE_METADATA_KEY]: attribution.stage };
}

/**
 * Recover an attribution from a run's metadata. Returns undefined unless BOTH
 * keys are present and the stage is one we know — a half-populated payload is
 * reported as unattributed rather than guessed at.
 */
export function attributionFromMetadata(
  metadata?: Record<string, unknown>,
): CostAttribution | undefined {
  const agent = metadata?.[COST_AGENT_METADATA_KEY];
  const stage = metadata?.[COST_STAGE_METADATA_KEY];
  if (typeof agent !== "string" || agent.length === 0 || !isCostStage(stage)) return undefined;
  return { agent, stage };
}

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
  "gemini-flash-latest":              { inputPerM: 0.075,  outputPerM: 0.30 },
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

// ── Model ID normalizer ───────────────────────────────────────────────────────

/**
 * Strip provider prefixes so MODEL_COSTS lookup works regardless of how the
 * model is configured. Without this, every call falls through to DEFAULT_COST:
 *   "openrouter:google/gemini-2.5-flash" → "gemini-2.5-flash"
 *   "openrouter:openai/gpt-4o-mini"      → "gpt-4o-mini"
 *   "google-genai:gemini-2.5-flash"      → "gemini-2.5-flash"
 *   "gemini-2.5-flash"                   → "gemini-2.5-flash" (unchanged)
 * Also strips trailing ":free" suffixes used by OpenRouter free-tier.
 */
const PROVIDER_PREFIXES = ["openrouter:", "google-genai:", "anthropic:", "openai:"];
const TIER_SUFFIXES = [":free", ":nitro", ":paid", ":beta"];

export function normalizeModelId(modelId: string): string {
  let name = modelId;
  // Strip known provider prefixes (e.g. "openrouter:", "google-genai:")
  for (const prefix of PROVIDER_PREFIXES) {
    if (name.startsWith(prefix)) {
      name = name.slice(prefix.length);
      break;
    }
  }
  // Strip vendor subdirectory (e.g. "google/gemini-2.5-flash" → "gemini-2.5-flash")
  const slashIdx = name.indexOf("/");
  if (slashIdx !== -1) {
    name = name.slice(slashIdx + 1);
    // Strip ":free"/":nitro" suffix that follows the model name after vendor stripping
    const colonSuffix = name.indexOf(":");
    if (colonSuffix !== -1) name = name.slice(0, colonSuffix);
    return name;
  }
  // For plain model IDs like "deepseek-r1:free" strip only known tier suffixes,
  // not arbitrary colons (avoids treating ":free" as a provider boundary).
  for (const suffix of TIER_SUFFIXES) {
    if (name.endsWith(suffix)) {
      name = name.slice(0, -suffix.length);
      break;
    }
  }
  return name;
}

// ── Pure cost estimator ───────────────────────────────────────────────────────

/**
 * Calculate the estimated cost of a single LLM call.
 * Pure function — no I/O, no side effects.
 * modelId is normalized before lookup so provider-prefixed strings resolve correctly.
 */
export function estimateCost(inputTokens: number, outputTokens: number, modelId: string): number {
  const normalized = normalizeModelId(modelId);
  const costs = MODEL_COSTS[normalized] ?? MODEL_COSTS[modelId] ?? DEFAULT_COST;
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

