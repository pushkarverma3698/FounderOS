/**
 * Prices for the models in the AG-031 A/B, in USD per million tokens.
 *
 * Eval-only on purpose. The production ledger's MODEL_COSTS (infra/budget-costs.ts)
 * has none of these models and silently prices them at a default of 0.10 / 0.50,
 * which would make every row of the A/B look nearly free. Touching that table
 * changes prod spend caps, so it stays out of this change; the A/B reads this one
 * and reports "n/a" for any model it has no verified price for.
 *
 * Verified 2026-10-07 against the providers' published list prices:
 *   Anthropic   https://www.anthropic.com/pricing
 *   Google      https://ai.google.dev/gemini-api/docs/pricing (output includes thinking)
 *   OpenRouter  https://openrouter.ai/api/v1/models (pricing.prompt / pricing.completion)
 * Re-check before reusing the dollar figures after 2026-12-31 or for another model.
 *
 * Pure: the date is an argument.
 */

import type { LlmCallUsage } from "./types.js";

export interface Price {
  readonly inputPerM: number;
  readonly outputPerM: number;
}

/** A price that applies from `from` (YYYY-MM-DD, inclusive) until the next tier. */
interface PriceTier extends Price {
  readonly from: string;
}

/** Gemini 3.x flash list price: promotional until 2026-12-31, doubled from 2027-01-01. */
const GEMINI_FLASH: readonly PriceTier[] = [
  { from: "2000-01-01", inputPerM: 0.75, outputPerM: 3.75 },
  { from: "2027-01-01", inputPerM: 1.5, outputPerM: 7.5 },
];

/** Keyed by model name with the provider prefix removed (vendor slashes stay). */
const PRICES: Readonly<Record<string, readonly PriceTier[]>> = {
  "claude-sonnet-5-5": [{ from: "2000-01-01", inputPerM: 2, outputPerM: 10 }],
  "gemini-3.6-flash": GEMINI_FLASH,
  "gemini-3.7-flash": GEMINI_FLASH,
  "gemini-3.8-flash": GEMINI_FLASH,
  // Up to 200k prompt tokens, which every eval turn is.
  "gemini-3.1-pro-preview": [{ from: "2000-01-01", inputPerM: 2, outputPerM: 12 }],
  "inclusionai/ling-3.0-flash": [{ from: "2000-01-01", inputPerM: 0.021, outputPerM: 0.063 }],
};

const PROVIDER_PREFIX = /^(openrouter|google-genai|google-vertexai|anthropic|openai|omnirouter):/;

/** The price of `modelId` on `onDate`, or undefined when there is no verified price. */
export function priceFor(modelId: string, onDate: string): Price | undefined {
  const tiers = PRICES[modelId.replace(PROVIDER_PREFIX, "")];
  const tier = tiers?.filter((t) => t.from <= onDate).at(-1);
  return tier && { inputPerM: tier.inputPerM, outputPerM: tier.outputPerM };
}

/** Dollars for one call, or undefined when its model has no verified price. */
export function callUsd(call: LlmCallUsage, onDate: string): number | undefined {
  const price = priceFor(call.model, onDate);
  if (!price) return undefined;
  return (call.inputTokens * price.inputPerM + call.outputTokens * price.outputPerM) / 1_000_000;
}
