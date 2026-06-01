/**
 * FounderOS v2 — Environment Configuration
 * ==========================================
 * Single location for env validation. All vars are validated at startup via
 * Zod — the app fails fast with a clear message rather than failing mid-request.
 *
 * Model selection lives in src/agents/model.ts (AGENT_MODEL env var).
 * Tool keys are read directly in each tool file for clear error messages.
 */

import { z } from "zod";

// ── Environment Schema ────────────────────────────────────────────────────────

const envSchema = z.object({
  // Database — required for checkpointer + audit log
  DATABASE_URL: z.string().url().describe("PostgreSQL connection string"),

  // Telegram — required to run the bot
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_CHAT_ID: z.string().min(1),

  // LLM — Google key required (Gemini Flash primary model)
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().transform(v => v || undefined).optional(),

  // Optional: override the agent model
  AGENT_MODEL: z.string().default("gemini-2.5-flash"),

  // Optional: override the tenant name
  FOUNDER_TENANT: z.string().default("turicks"),

  // Tool keys — optional; tools fail loudly when key is missing
  COMPOSIO_API_KEY: z.string().transform(v => v || undefined).optional(),
  FIRECRAWL_API_KEY: z.string().transform(v => v || undefined).optional(),
  GITHUB_TOKEN: z.string().transform(v => v || undefined).optional(),
  OPENAI_API_KEY: z.string().transform(v => v || undefined).optional(),

  // Observability — optional, degrades gracefully
  LANGCHAIN_API_KEY: z.string().optional(),
  LANGCHAIN_PROJECT: z.string().default("founderos"),
  LANGCHAIN_TRACING_V2: z.enum(["true", "false"]).default("false"),

  // Runtime
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),

  // Redis — optional; used only if a tool requires it
  REDIS_URL: z.string().url().default("redis://localhost:6379"),

  // Budget — unused in v2 but kept so tests that stub it don't fail
  BUDGET_DAILY_USD: z.coerce.number().positive().default(5.0),
});

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
