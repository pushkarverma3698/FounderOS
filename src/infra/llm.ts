/**
 * FounderOS — LLM Provider Cascade
 * ==================================
 * Unified LLM caller with:
 *  1. Provider cascade — tries entries in order, stops on first success
 *  2. Circuit breaker per provider (opossum) — trips after 3 failures, resets after 5 min
 *  3. Global rate limiter (bottleneck) — max 5 concurrent, 200ms between requests
 *  4. Cost recording — writes to llm_costs after every successful call
 *  5. Structured logging with tier/model/tokens context
 *
 * Usage:
 *   const text = await callCascade("ceo", messages, { agent: "supervisor" });
 */

import { generateText, type CoreMessage } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import CircuitBreaker from "opossum";
import Bottleneck from "bottleneck";
import {
  CASCADE,
  CIRCUIT_BREAKER_OPTIONS,
  env,
  MODEL_COST_PER_1M,
  RATE_LIMITER_OPTIONS,
  TIER_MAX_TOKENS,
  type CascadeEntry,
} from "../core/config.js";
import type { CascadeTier } from "../core/registry.js";
import { logLlmCost } from "../db/queries.js";
import { childLogger } from "./logger.js";

const log = childLogger({ module: "llm" });

// ── Provider Factories ────────────────────────────────────────────────────────

function getProviderModel(entry: CascadeEntry) {
  switch (entry.provider) {
    case "anthropic": {
      const client = createAnthropic({ apiKey: env.ANTHROPIC_API_KEY });
      return client(entry.modelId);
    }
    case "google": {
      const client = createGoogleGenerativeAI({ apiKey: env.GOOGLE_GENERATIVE_AI_API_KEY });
      return client(entry.modelId);
    }
    case "openai": {
      const client = createOpenAI({ apiKey: env.OPENAI_API_KEY });
      return client(entry.modelId);
    }
    case "openrouter": {
      const client = createOpenAI({
        apiKey: env.OPENROUTER_API_KEY,
        baseURL: "https://openrouter.ai/api/v1",
      });
      return client(entry.modelId);
    }
    case "lmstudio": {
      const client = createOpenAI({
        apiKey: "lm-studio",
        baseURL: `${env.LM_STUDIO_URL}/v1`,
      });
      return client(entry.modelId);
    }
  }
}

// ── Rate Limiter (global, shared across all providers) ────────────────────────

const limiter = new Bottleneck({
  maxConcurrent: RATE_LIMITER_OPTIONS.maxConcurrent,
  minTime: RATE_LIMITER_OPTIONS.minTime,
});

// ── Circuit Breakers (per provider:model) ─────────────────────────────────────

/**
 * Each circuit breaker wraps a function that accepts (entry, messages, maxTokens, system).
 * We store one breaker per `provider:modelId` key.
 *
 * Architecture Review fix: breakers were created but never used in callCascade.
 * Now each cascade entry is fired through its breaker — if a provider trips 3 times
 * in a row, it is skipped for CIRCUIT_BREAKER_OPTIONS.resetTimeout ms (default 5 min).
 */
type BreakerResult = { text: string; tokensIn: number; tokensOut: number };
type BreakerAction = (
  entry: CascadeEntry,
  messages: CoreMessage[],
  maxTokens: number,
  system?: string,
) => Promise<BreakerResult>;

const breakers = new Map<string, CircuitBreaker<Parameters<BreakerAction>, BreakerResult>>();

function getBreaker(key: string): CircuitBreaker<Parameters<BreakerAction>, BreakerResult> {
  if (!breakers.has(key)) {
    // TR = BreakerResult (the resolved value); opossum wraps it in Promise<TR>.
    // The action must return Promise<TR>, which callEntry does.
    const breaker = new CircuitBreaker<Parameters<BreakerAction>, BreakerResult>(
      (entry, msgs, maxTok, sys) => callEntry(entry, msgs, maxTok, sys),
      CIRCUIT_BREAKER_OPTIONS,
    );

    breaker.on("open", () => log.warn({ model: key }, "Circuit breaker OPEN — skipping provider"));
    breaker.on("halfOpen", () => log.info({ model: key }, "Circuit breaker half-open — testing"));
    breaker.on("close", () => log.info({ model: key }, "Circuit breaker CLOSED — provider recovered"));
    breaker.on("fallback", () => log.debug({ model: key }, "Circuit breaker fallback triggered"));

    breakers.set(key, breaker);
  }
  return breakers.get(key)!;
}

/** Check if a provider's circuit breaker is currently open (provider unhealthy). */
export function isBreakerOpen(providerModelKey: string): boolean {
  return breakers.get(providerModelKey)?.opened ?? false;
}

// ── Core LLM call ─────────────────────────────────────────────────────────────

async function callEntry(
  entry: CascadeEntry,
  messages: CoreMessage[],
  maxTokens: number,
  system?: string,
): Promise<{ text: string; tokensIn: number; tokensOut: number }> {
  const model = getProviderModel(entry);

  const result = await generateText({
    model,
    messages,
    system,
    maxTokens,
    temperature: 0.3, // Deterministic enough for business tasks, not robotic
  });

  return {
    text: result.text,
    tokensIn: result.usage.promptTokens,
    tokensOut: result.usage.completionTokens,
  };
}

// ── Cascade Executor ──────────────────────────────────────────────────────────

export interface CascadeCallOpts {
  /** Agent name for cost tracking and logging. */
  agent: string;
  /** Tenant for cost tracking. */
  tenant_id?: string;
  /** Override system prompt for this call. */
  system?: string;
  /** Override max tokens for this call. Falls back to TIER_MAX_TOKENS[tier]. */
  maxTokens?: number;
}

export interface CascadeResult {
  text: string;
  model: string;
  provider: string;
  tier: CascadeTier;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

/**
 * Call the LLM cascade for a tier.
 * Tries each entry in order, records cost, returns first success.
 * Throws if ALL entries fail.
 */
export async function callCascade(
  tier: CascadeTier,
  messages: CoreMessage[],
  opts: CascadeCallOpts,
): Promise<CascadeResult> {
  const entries = CASCADE[tier];
  const maxTokens = opts.maxTokens ?? TIER_MAX_TOKENS[tier];
  const tenantId = opts.tenant_id ?? "turicks";
  const errors: Error[] = [];

  for (const entry of entries) {
    const key = `${entry.provider}:${entry.modelId}`;

    try {
      const breaker = getBreaker(key);

      // Skip this provider early if breaker is already open (saves latency)
      if (breaker.opened) {
        log.debug({ tier, model: key }, "Circuit breaker open — skipping provider");
        errors.push(new Error(`${key}: circuit breaker open`));
        continue;
      }

      const { text, tokensIn, tokensOut } = await limiter.schedule(() =>
        breaker.fire(entry, messages, entry.maxTokens ?? maxTokens, opts.system),
      );

      // Record cost
      const pricing = MODEL_COST_PER_1M[entry.modelId];
      const costUsd = pricing
        ? (tokensIn * pricing.input + tokensOut * pricing.output) / 1_000_000
        : 0;

      // Non-blocking cost write — don't let DB failure break the LLM call
      logLlmCost({
        tenant_id: tenantId,
        agent: opts.agent,
        tier,
        model: entry.modelId,
        tokens_in: tokensIn,
        tokens_out: tokensOut,
        cost_usd: costUsd.toFixed(6),
      }).catch((err: Error) => log.warn({ err: err.message }, "Failed to log LLM cost"));

      log.debug(
        { tier, model: entry.modelId, tokensIn, tokensOut, costUsd: costUsd.toFixed(6) },
        "LLM call success",
      );

      return {
        text,
        model: entry.modelId,
        provider: entry.provider,
        tier,
        tokensIn,
        tokensOut,
        costUsd,
      };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      errors.push(error);
      log.warn(
        { tier, model: entry.modelId, provider: entry.provider, err: error.message },
        "Cascade entry failed — trying next",
      );
    }
  }

  throw new AggregateError(
    errors,
    `All cascade entries for tier "${tier}" failed:\n${errors.map((e) => `  - ${e.message}`).join("\n")}`,
  );
}

// ── Budget Guard ──────────────────────────────────────────────────────────────

/**
 * Check if today's spend exceeds BUDGET_DAILY_USD.
 * Call at the start of expensive operations (CEO, deep_research).
 */
export async function checkBudget(tenantId: string): Promise<void> {
  const { getTodayCostUsd } = await import("../db/queries.js");
  const spent = await getTodayCostUsd(tenantId);

  if (spent >= env.BUDGET_DAILY_USD) {
    throw new Error(
      `Budget exceeded: $${spent.toFixed(4)} spent today, limit is $${env.BUDGET_DAILY_USD}. ` +
        `Free-tier models only until midnight UTC.`,
    );
  }

  log.debug({ tenantId, spent: spent.toFixed(4), limit: env.BUDGET_DAILY_USD }, "Budget OK");
}
