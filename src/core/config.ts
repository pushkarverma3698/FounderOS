/**
 * FounderOS — Master Configuration
 * ==================================
 * Single location for all env validation, model cascades, and budget limits.
 * All env vars are validated at startup via Zod — the app fails fast if
 * required keys are missing rather than failing mid-request.
 *
 * ═══════════════════════════════════════════════════════════════
 * MODEL ROUTING STRATEGY — Local vs Cloud
 * ═══════════════════════════════════════════════════════════════
 *
 * LOCAL (LM Studio / Ollama) — use when:
 *   • Task is deterministic or short (code generation, JSON extraction)
 *   • Privacy matters (internal Turicks data)
 *   • latency is acceptable (streaming, not real-time chat)
 *   • We want zero API cost on high-frequency tasks
 *   Tiers:  `code`, `local`
 *
 * CLOUD — use when:
 *   • Complex reasoning or nuanced judgement is required (CEO routing,
 *     ICP scoring, outreach strategy, content critique)
 *   • Multi-step chain-of-thought quality matters (deep research)
 *   • Speed and reliability are paramount (HITL approvals)
 *   Tiers:  `ceo`, `deep_research`, `md`, `nano`, `critic`
 *
 * COST-OPTIMISED CLOUD MODEL RECOMMENDATIONS
 * ───────────────────────────────────────────
 *
 * Gemini 2.0 Flash ($0.075/1M in, $0.30/1M out)
 *   → THE daily workhorse for FounderOS.
 *     Use for: BDR email drafts, marketing briefs, engineer planning,
 *     ICP scoring, disambiguate, most `md` and `nano` tier tasks.
 *     Excellent instruction following, 1M context, no reasoning overhead.
 *
 * Claude Haiku 4.5 ($0.25/1M in, $1.25/1M out)
 *   → Critic-tier primary and MD fallback.
 *     Use when you need different model family from generator (anti-sycophancy).
 *     Better at structured JSON critique than Flash; still cheap.
 *
 * Gemini 2.5 Pro ($1.25/1M in, $10/1M out)
 *   → Deep research ONLY. Its extended thinking shines on lead intelligence.
 *     Do NOT use for drafting or classification — overpriced for that.
 *
 * Claude Sonnet 4.5 ($3.00/1M in, $15/1M out)
 *   → CEO supervisor routing ONLY. You need a different model family from
 *     Gemini for the top-level router (Gemini would route to itself).
 *     If costs spike, replace with claude-haiku — routing doesn't need Sonnet.
 *
 * AVOID: Do NOT use Gemini 2.5 Pro or Sonnet for BDR, critic, or planning.
 *         Those tasks are solved by Flash + Haiku at 1/10th the price.
 *
 * ═══════════════════════════════════════════════════════════════
 * Cascade Tiers
 * ═══════════════════════════════════════════════════════════════
 * CEO:           claude-sonnet-4-5 → gemini-2.5-pro → gemini-2.5-flash
 * Deep Research: gemini-2.5-pro → gemini-2.5-flash → openrouter/deepseek-r1
 * MD:            gemini-2.5-flash → claude-haiku-4-5 → openrouter/llama-70b
 * Code:          lmstudio/qwen-coder → openrouter/qwen3-coder → gemini-2.5-flash
 * Nano:          gemini-2.5-flash-lite → claude-haiku-4-5
 * Critic:        claude-haiku-4-5 → gemini-2.5-flash  (Claude first — anti-sycophancy)
 */

import { z } from "zod";
import type { CascadeTier } from "./registry.js";

// ── Environment Schema ────────────────────────────────────────────────────────

const envSchema = z.object({
  // Database
  DATABASE_URL: z.string().url().describe("PostgreSQL connection string"),

  // LLM Providers (at least one is required)
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().min(1).optional(),
  OPENROUTER_API_KEY: z.string().min(1).optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),

  // Telegram
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_CHAT_ID: z.string().min(1),
  TOPIC_BOARDROOM: z.coerce.number().default(0),
  TOPIC_THINK_TANK: z.coerce.number().default(0),
  TOPIC_TURICKS: z.coerce.number().default(0),
  TOPIC_NAGGAR: z.coerce.number().default(0),
  TOPIC_SOCIAL: z.coerce.number().default(0),

  // Observability (optional — degrades gracefully)
  LANGCHAIN_API_KEY: z.string().optional(),
  LANGCHAIN_PROJECT: z.string().default("founderos"),
  LANGCHAIN_TRACING_V2: z.enum(["true", "false"]).default("false"),

  // Tools
  FIRECRAWL_API_KEY: z.string().optional(),
  COMPOSIO_API_KEY: z.string().optional(),
  OPENWEATHER_API_KEY: z.string().optional(),

  // Local model (LM Studio)
  LM_STUDIO_URL: z.string().url().default("http://localhost:1234"),
  LM_STUDIO_MODEL: z.string().default("qwen2.5-coder-7b-instruct"),

  // Redis (caching: research results, quota counters, LLM prompt cache)
  REDIS_URL: z.string().url().default("redis://localhost:6379"),

  // Daily send quota (enforced via Redis INCR per tenant per day)
  DAILY_SEND_LIMIT: z.coerce.number().positive().default(10),

  // Budget controls
  BUDGET_DAILY_USD: z.coerce.number().positive().default(5.0),

  // Runtime
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
});

// Validate once at module load — fail fast
function parseEnv() {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`❌ FounderOS env validation failed:\n${issues}\n\nSee .env.example for required variables.`);
  }
  return result.data;
}

export const env = parseEnv();

// ── Model Cascade Types ───────────────────────────────────────────────────────

export type LLMProvider = "anthropic" | "google" | "openai" | "openrouter" | "lmstudio";

export interface CascadeEntry {
  readonly provider: LLMProvider;
  readonly modelId: string;
  /** Maximum tokens for this tier entry. Overrides tier default if set. */
  readonly maxTokens?: number;
}

// ── Cascade Definitions ───────────────────────────────────────────────────────

export const CASCADE: Record<CascadeTier, CascadeEntry[]> = {
  ceo: [
    { provider: "anthropic", modelId: "claude-sonnet-4-5" },
    { provider: "google",    modelId: "gemini-2.5-pro" },
    { provider: "google",    modelId: "gemini-2.5-flash" },
    { provider: "openrouter", modelId: "meta-llama/llama-3.3-70b-instruct:free" },
  ],

  deep_research: [
    { provider: "google",     modelId: "gemini-2.5-pro" },
    { provider: "google",     modelId: "gemini-2.5-flash" },
    { provider: "openrouter", modelId: "deepseek/deepseek-v4-flash:free" },
  ],

  md: [
    { provider: "google",     modelId: "gemini-2.5-flash" },
    { provider: "anthropic",  modelId: "claude-haiku-4-5" },
    { provider: "openrouter", modelId: "meta-llama/llama-3.3-70b-instruct:free" },
  ],

  code: [
    { provider: "lmstudio",   modelId: env.LM_STUDIO_MODEL },
    { provider: "openrouter", modelId: "qwen/qwen3-coder:free" },
    { provider: "google",     modelId: "gemini-2.5-flash" },
  ],

  nano: [
    { provider: "google",    modelId: "gemini-2.5-flash-lite" },
    { provider: "anthropic", modelId: "claude-haiku-4-5" },
  ],

  local: [
    { provider: "lmstudio",  modelId: env.LM_STUDIO_MODEL },
    { provider: "google",    modelId: "gemini-2.5-flash-lite" },
  ],

  video: [
    { provider: "google", modelId: "veo-2.0-generate-001" },
  ],

  // Critic tier: Claude-FIRST to prevent sycophancy (generators use Gemini)
  // Fallback order: Claude → Gemini Flash → OpenRouter Llama (any non-Gemini satisfies anti-sycophancy)
  critic: [
    { provider: "anthropic",  modelId: "claude-haiku-4-5" },
    { provider: "google",     modelId: "gemini-2.5-flash" },
    { provider: "openrouter", modelId: "meta-llama/llama-3.3-70b-instruct:free" },
  ],
};

// ── Token Limits Per Tier ─────────────────────────────────────────────────────

export const TIER_MAX_TOKENS: Record<CascadeTier, number> = {
  ceo:           512,   // CEO only classifies/routes — keep it tight
  deep_research: 4096,  // Research needs synthesis space
  md:            2048,  // Business outputs: proposals, reports, emails
  code:          4096,  // Code generation needs room
  nano:          256,   // Captions, standups, micro-tasks
  local:         1024,  // Local model — balanced
  video:         256,   // Video prompt — short
  critic:        1024,  // Critic verdict — structured JSON output
};

// ── Budget Guard ──────────────────────────────────────────────────────────────

/** Approximate cost per 1M tokens for each model (USD). Used by cost_watchdog. */
export const MODEL_COST_PER_1M: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-5":          { input: 3.00,  output: 15.00 },
  "claude-haiku-4-5":           { input: 0.25,  output: 1.25 },
  "gemini-2.5-pro":             { input: 1.25,  output: 10.00 },
  "gemini-2.5-flash":           { input: 0.075, output: 0.30 },
  "gemini-2.5-flash-lite":      { input: 0.0375, output: 0.15 },
  // Free models
  "meta-llama/llama-3.3-70b-instruct:free": { input: 0, output: 0 },
  "deepseek/deepseek-r1:free":              { input: 0, output: 0 },
  "qwen/qwen3-coder:free":                  { input: 0, output: 0 },
};

// ── Circuit Breaker Config (passed to opossum) ────────────────────────────────

export const CIRCUIT_BREAKER_OPTIONS = {
  timeout: 30_000,        // 30s per LLM call
  errorThresholdPercentage: 50,
  resetTimeout: 300_000,  // 5-minute cooldown
  volumeThreshold: 3,     // Trip after 3 failures
} as const;

// ── Rate Limiter Config (passed to bottleneck) ────────────────────────────────

export const RATE_LIMITER_OPTIONS = {
  maxConcurrent: 5,
  minTime: 200, // ms between requests (global across all providers)
} as const;

// ── Redis Cache TTLs (seconds) ────────────────────────────────────────────────

/**
 * LLM prompt response cache TTLs per tier.
 * CEO = 0 (never cache — decisions must always be fresh).
 * MD = 1 hour, NANO = 24 hours (stable outputs, significant cost saving).
 */
export const LLM_CACHE_TTL: Partial<Record<CascadeTier, number>> = {
  ceo:           0,      // never cache — decisions must be fresh
  deep_research: 3600,   // 1 hour
  md:            3600,   // 1 hour
  code:          1800,   // 30 min (code changes fast)
  nano:          86400,  // 24 hours
  local:         0,      // local model — no caching
  critic:        0,      // critic must evaluate fresh content
} as const;

/** Research cache TTL: 7 days (company data is stable at this timescale). */
export const RESEARCH_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
