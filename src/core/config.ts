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
  /** Gmail backend: gws | googleapis (service account, unattended) | composio (legacy rollback). ADR-029 */
  GMAIL_BACKEND: z.enum(["composio", "gws", "googleapis"]).default("gws"),
  CALENDAR_BACKEND: z.enum(["composio", "gws", "googleapis"]).optional(),
  GWS_BIN: z.string().transform(v => v || undefined).optional(),
  PROVIDER_SMOKE_AT_BOOT: z.enum(["true", "false"]).optional(),
  PROVIDER_PROBE_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  /** LinkedIn direct API (default backend). ADR-029 */
  LINKEDIN_BACKEND: z.enum(["composio", "direct"]).default("direct"),
  LINKEDIN_ACCESS_TOKEN: z.string().transform(v => v || undefined).optional(),
  LINKEDIN_AUTHOR_URN: z.string().transform(v => v || undefined).optional(),
  LINKEDIN_API_VERSION: z.string().transform(v => v || undefined).optional(),
  GITHUB_TOKEN: z.string().transform(v => v || undefined).optional(),

  // ── Apify web scraper (research department real-data engine) ────────────────
  /** Apify API token (https://apify.com → Console → Integrations). One key, all
   *  environments. Absent → research scrape tools fall back to keyless fetch. */
  APIFY_TOKEN: z.string().transform(v => v || undefined).optional(),
  /** Apify REST base URL. Override only for self-hosted/proxy setups. */
  APIFY_BASE_URL: z.string().url().default("https://api.apify.com/v2"),
  /** Scrape backend: "apify" (default) uses Apify actors; "fetch" forces the
   *  keyless in-process fallback even when a token is set (offline/dev). */
  SCRAPE_BACKEND: z.enum(["apify", "fetch"]).default("apify"),

  // Observability — optional, degrades gracefully
  LANGCHAIN_API_KEY: z.string().optional(),
  LANGCHAIN_PROJECT: z.string().default("founderos"),
  LANGCHAIN_TRACING_V2: z.enum(["true", "false"]).default("false"),

  // Runtime
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),

  /** Web gateway (JARVIS UI) — optional Bearer token; unset = open in dev. */
  WEB_GATEWAY_TOKEN: z.string().transform(v => v || undefined).optional(),
  /** Unused — web gateway shares HEALTH_PORT. Kept for backward compat in .env files. */
  WEB_GATEWAY_PORT: z.coerce.number().int().positive().default(3002),

  /** Enable Telegram long-polling in this process. Default: on in production, off in
   * development — avoids 409 conflicts when the prod VPS bot already polls the same
   * token while running Jarvis/E2E locally. Web gateway (/api/v1/*) stays up either way.
   */
  TELEGRAM_POLLING_ENABLED: z.enum(["true", "false"]).optional(),

  // Redis — optional; SaaS-phase only, not wired into any prod send path.
  // Empty string or missing → undefined (Redis client skips connection).
  REDIS_URL: z.preprocess(v => (v === "" ? undefined : v), z.string().url().optional()),

  // ── External MCP client bridge (ADR-041) ────────────────────────────────────
  /** Connect agents to external MCP servers declared in the bridge manifest.
   *  Default OFF — flag-gated so the default build is byte-identical until a
   *  founder explicitly opts in. Reads pass through; writes are HITL-gated. */
  MCP_BRIDGE_ENABLED: z.enum(["true", "false"]).default("false"),
  /** Path to the bridge manifest (servers + per-server write allowlist). */
  MCP_BRIDGE_MANIFEST: z.string().default("mcp-bridge.json"),

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

  // ── RAG backend ──────────────────────────────────────────────────────────
  /** "pgvector" (default, requires Ollama) or "ragflow" (self-hosted RAGFlow). */
  RAG_BACKEND: z.enum(["pgvector", "ragflow"]).default("pgvector"),
  RAGFLOW_BASE_URL: z.string().url().optional().or(z.literal("")).transform(v => v || undefined),
  RAGFLOW_API_KEY: z.string().transform(v => v || undefined).optional(),
  /** UUID of the RAGFlow knowledge-base dataset to query/upload into. */
  RAGFLOW_DATASET_ID: z.string().transform(v => v || undefined).optional(),

  /** TTL (seconds) for the Redis scrape cache — dedups repeat scrapes of the
   *  same URL/query so we don't re-pay Apify credits + re-embed. Default 24h. */
  RESEARCH_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(86_400),

  // ── mem0 episodic memory cloud ────────────────────────────────────────────
  /** When set, events are also pushed to mem0 cloud for semantic recall. */
  MEM0_API_KEY: z.string().transform(v => v || undefined).optional(),
  /** mem0 user_id — defaults to FOUNDER_TENANT (e.g. "turicks"). */
  MEM0_USER_ID: z.string().transform(v => v || undefined).optional(),

  // ── Browser backend ───────────────────────────────────────────────────────
  /** "auto" = Playwright on linux, AppleScript on darwin. Override as needed. */
  BROWSER_BACKEND: z.enum(["auto", "playwright", "applescript"]).default("auto"),

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

/** Daily LLM spend cap (USD) — enforced at gateway before new runs. */
export const DAILY_BUDGET_USD = env.BUDGET_DAILY_USD;

/** Per-run LLM spend cap (USD). */
export const RUN_BUDGET_USD = env.RUN_BUDGET_USD;

/** Per-run token cap (input + output). */
export const RUN_BUDGET_TOKENS = env.RUN_BUDGET_TOKENS;

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
export const ENGINEERING_SUBGRAPH_ENABLED = boolEnv("ENGINEERING_SUBGRAPH", true);

/**
 * Promote marketing + sales into a `revenue` sub-supervisor (ADR-028 / ADR-025).
 * Default OFF — live MTProto nested-HITL verification required before production.
 */
export const REVENUE_SUBGRAPH_ENABLED = boolEnv("REVENUE_SUBGRAPH", true);

/**
 * Long-poll Telegram in this process. Off in development by default so local
 * `pnpm dev` can serve Jarvis without fighting the prod bot for getUpdates.
 * Set TELEGRAM_POLLING_ENABLED=true explicitly to run the gateway locally.
 */
export const TELEGRAM_POLLING_ENABLED = boolEnv(
  "TELEGRAM_POLLING_ENABLED",
  env.NODE_ENV === "production",
);

/**
 * Connect agents to external MCP servers (ADR-041). Default OFF — the single,
 * reversible lever that merges manifest-declared external tools into the
 * department arrays. Reads pass through; writes route through hitlGate.
 */
export const MCP_BRIDGE_ENABLED = env.MCP_BRIDGE_ENABLED === "true";

/** Filesystem path to the external MCP bridge manifest. */
export const MCP_BRIDGE_MANIFEST = env.MCP_BRIDGE_MANIFEST;

/** Max recursive supervisor/sub-agent steps before LangGraph aborts a run. */
export const OFFICE_RECURSION_LIMIT = intEnv("OFFICE_RECURSION_LIMIT", 40);

/**
 * Hard ceiling on a single office turn (ms). A hung model/tool call otherwise
 * leaves the founder with the typing indicator forever and NO reply — the worst
 * silent-failure class. On expiry the gateway aborts loud, clears the thread, and
 * tells the founder. Generous default (3 min) so legitimate multi-step / claude_code
 * runs finish; override with OFFICE_TURN_TIMEOUT_MS. Set 0 to disable (not advised).
 */
export const OFFICE_TURN_TIMEOUT_MS = intEnv("OFFICE_TURN_TIMEOUT_MS", 180_000);

/**
 * Daily outbound send quotas (G4 gap — now enforced via action_log count).
 * Postgres-backed: survives restarts, accurate under concurrent sends.
 * Override via env: DAILY_EMAIL_LIMIT / DAILY_LINKEDIN_LIMIT.
 * Set to 0 to disable the ceiling (not recommended before volume outbound).
 */
export const DAILY_EMAIL_LIMIT = intEnv("DAILY_EMAIL_LIMIT", 20);
export const DAILY_LINKEDIN_LIMIT = intEnv("DAILY_LINKEDIN_LIMIT", 3);

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
