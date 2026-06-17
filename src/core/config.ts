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

export const envSchema = z.object({
  // Database — required for checkpointer + audit log
  DATABASE_URL: z.string().url().describe("PostgreSQL connection string"),

  // Telegram — required to run the bot
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_CHAT_ID: z.string().min(1),

  // LLM providers — one key must match the selected AGENT_MODEL provider.
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().transform(v => v || undefined).optional(),
  OPENAI_API_KEY: z.string().transform(v => v || undefined).optional(),
  ANTHROPIC_API_KEY: z.string().transform(v => v || undefined).optional(),
  OPENROUTER_API_KEY: z.string().transform(v => v || undefined).optional(),

  // Optional: override the agent model. Prefixes are explicit provider routing.
  AGENT_MODEL: z.string().default("openrouter:openai/gpt-4o-mini"),
  AGENT_FALLBACK_MODELS: z.string().transform(v => v || undefined).optional(),

  // Optional: override the tenant name
  FOUNDER_TENANT: z.string().default("turicks"),

  // Tool keys — optional; tools fail loudly when key is missing
  COMPOSIO_API_KEY: z.string().transform(v => v || undefined).optional(),
  /** Gmail read backend: composio (default) or gws (Google Workspace CLI). ADR-028 */
  GMAIL_BACKEND: z.enum(["composio", "gws"]).default("composio"),
  GWS_BIN: z.string().transform(v => v || undefined).optional(),
  PROVIDER_SMOKE_AT_BOOT: z.enum(["true", "false"]).optional(),
  PROVIDER_PROBE_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  GITHUB_TOKEN: z.string().transform(v => v || undefined).optional(),

  // Observability — optional, degrades gracefully
  LANGCHAIN_API_KEY: z.string().optional(),
  LANGCHAIN_PROJECT: z.string().default("founderos"),
  LANGCHAIN_TRACING_V2: z.enum(["true", "false"]).default("false"),

  // Runtime
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),

  // Redis — optional; used only if a tool requires it
  REDIS_URL: z.string().url().default("redis://localhost:6379"),

  // Global halt (kill switch) — optional flag-file path override.
  // Default: $HOME/.founderos/HALT (resolved in src/infra/halt.ts).
  HALT_FLAG_PATH: z.string().transform(v => v || undefined).optional(),

  // ── Embeddings (local Ollama) ───────────────────────────────────────────
  OLLAMA_URL: z.string().url().default("http://localhost:11434"),
  EMBED_MODEL: z.string().default("nomic-embed-text"),
  EMBED_DIM: z.coerce.number().int().positive().default(768),

  // ── Claude Code executor (optional API-key fallback; OAuth used when unset) ──
  CLAUDE_EXECUTOR_API_KEY: z.string().transform(v => v || undefined).optional(),
  CLAUDE_EXECUTOR_BASE_URL: z.string().transform(v => v || undefined).optional(),

  // Budget controls
  BUDGET_DAILY_USD: z.coerce.number().positive().default(5.0),
  // Per-run caps — applied to each individual office.invoke() call
  RUN_BUDGET_USD: z.coerce.number().positive().default(0.50),
  RUN_BUDGET_TOKENS: z.coerce.number().int().positive().default(50_000),
}).superRefine((cfg, ctx) => {
  if (cfg.NODE_ENV !== "production") return;

  const provider = cfg.AGENT_MODEL.includes(":")
    ? cfg.AGENT_MODEL.split(":", 1)[0]
    : cfg.AGENT_MODEL.includes("gemini")
      ? "google-genai"
      : cfg.AGENT_MODEL.includes("claude")
        ? "anthropic"
        : "openai";
  const missing =
    provider === "google-genai" ? !cfg.GOOGLE_GENERATIVE_AI_API_KEY :
    provider === "anthropic" ? !cfg.ANTHROPIC_API_KEY :
    provider === "openrouter" ? !cfg.OPENROUTER_API_KEY :
    provider === "openai" ? !cfg.OPENAI_API_KEY :
    true;

  if (missing) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["AGENT_MODEL"],
      message:
        `selected provider "${provider}" needs a matching production API key. Set AGENT_MODEL and the provider key in the prod .env (or PROD_DOTENV secret).`,
    });
  }
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

/**
 * The active tenant id. Single source of truth — previously this constant was
 * re-declared identically in five files (gateway, agent-tools, context, memory,
 * knowledge). Import this everywhere instead of re-reading the env var.
 */
export const TENANT = env.FOUNDER_TENANT;

/** Parse a positive-integer env var, falling back to a default for unset/garbage. */
function intEnv(key: string, fallback: number): number {
  const n = Number(process.env[key]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Parse a boolean env var ("1"/"true"/"yes" → true), falling back to a default. */
function boolEnv(key: string, fallback = false): boolean {
  const v = (process.env[key] ?? "").trim().toLowerCase();
  if (v === "") return fallback;
  return v === "1" || v === "true" || v === "yes";
}

/**
 * Promote the engineering department to the CTO sub-supervisor (coder/qa/devops).
 * Default OFF — production stays flat until the 3-level nested-HITL path is
 * live-verified over real Telegram (hierarchy plan P2 gate, rule #19.6). Flipping
 * this to "1" is the single, reversible lever that swaps the flat engineering
 * ReAct agent for the hierarchical CTO subgraph in office.ts.
 */
export const ENGINEERING_SUBGRAPH_ENABLED = boolEnv("ENGINEERING_SUBGRAPH", false);

/**
 * Promote marketing + sales into a `revenue` sub-supervisor (ADR-028 / ADR-025).
 * Default OFF — live MTProto nested-HITL verification required before production.
 */
export const REVENUE_SUBGRAPH_ENABLED = boolEnv("REVENUE_SUBGRAPH", false);

/** Max recursive supervisor/sub-agent steps before LangGraph aborts a run. */
export const OFFICE_RECURSION_LIMIT = intEnv("OFFICE_RECURSION_LIMIT", 40);

/**
 * How many human turns of conversation history to persist per thread.
 * Kept deliberately small: the prebuilt supervisor forwards the FULL kept window
 * to every sub-agent on handoff, so any stale leading message pollutes routing.
 * Prod 2026-06-15: at 12, the thread's first message ("Do it yourself don't use
 * claude") never aged out and leaked into every transfer_to_* for hours, driving
 * generic/wrong sub-agent searches. 4 keeps real follow-up context while evicting
 * unrelated older turns fast. Durable context lives in memory tools, not history.
 */
export const HISTORY_KEEP_TURNS = intEnv("HISTORY_KEEP_TURNS", 4);
