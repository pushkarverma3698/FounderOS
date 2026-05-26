/**
 * FounderOS — Master Configuration
 * ==================================
 * Single location for all env validation, model cascades, and budget limits.
 * All env vars are validated at startup via Zod — the app fails fast if
 * required keys are missing rather than failing mid-request.
 *
 * Model Cascade Philosophy
 * ─────────────────────────
 * Each tier has a primary → fallback chain, tried in order.
 * Circuit breaker (opossum) + rate limiter (bottleneck) wrap each call.
 *
 * CEO:           claude-sonnet-4-5 → gemini-2.5-pro → gemini-flash
 * Deep Research: gemini-2.5-pro → gemini-flash → openrouter/deepseek-r1
 * MD:            gemini-flash → claude-haiku → openrouter/llama-70b
 * Code:          lmstudio/qwen-coder → gemini-flash → openrouter/qwen-coder
 * Nano:          gemini-flash-lite → claude-haiku
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
    { provider: "google",    modelId: "gemini-2.0-flash" },
    { provider: "openrouter", modelId: "meta-llama/llama-3.3-70b-instruct:free" },
  ],

  deep_research: [
    { provider: "google",     modelId: "gemini-2.5-pro" },
    { provider: "google",     modelId: "gemini-2.0-flash" },
    { provider: "openrouter", modelId: "deepseek/deepseek-r1:free" },
  ],

  md: [
    { provider: "google",     modelId: "gemini-2.0-flash" },
    { provider: "anthropic",  modelId: "claude-haiku-4-5" },
    { provider: "openrouter", modelId: "meta-llama/llama-3.3-70b-instruct:free" },
  ],

  code: [
    { provider: "lmstudio",   modelId: env.LM_STUDIO_MODEL },
    { provider: "openrouter", modelId: "qwen/qwen3-coder:free" },
    { provider: "google",     modelId: "gemini-2.0-flash" },
  ],

  nano: [
    { provider: "google",    modelId: "gemini-2.0-flash-lite" },
    { provider: "anthropic", modelId: "claude-haiku-4-5" },
  ],

  local: [
    { provider: "lmstudio",  modelId: env.LM_STUDIO_MODEL },
    { provider: "google",    modelId: "gemini-2.0-flash-lite" },
  ],

  video: [
    { provider: "google", modelId: "veo-2.0-generate-001" },
  ],

  // Critic tier: Claude-FIRST to prevent sycophancy (generators use Gemini)
  critic: [
    { provider: "anthropic", modelId: "claude-haiku-4-5" },
    { provider: "google",    modelId: "gemini-2.0-flash" },
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
  "gemini-2.0-flash":           { input: 0.075, output: 0.30 },
  "gemini-2.0-flash-lite":      { input: 0.0375, output: 0.15 },
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
