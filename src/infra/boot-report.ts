/**
 * FounderOS — Boot Capability Report
 * ===================================
 * Logs, once at startup, which integrations are LIVE vs MISSING based on the
 * env/config that's present. This turns the silent half-dead-bot failure mode
 * (where a missing key only surfaces when a department is invoked) into a
 * single scannable line in journald:
 *
 *   journalctl -u founderos | grep boot
 *
 * `buildBootReport` is a PURE function (env in → statuses out) so it is unit
 * tested without touching process state. `logBootReport` does the I/O.
 */

import { logger } from "./logger.js";

const log = logger.child({ module: "boot" });

/** The subset of env/config keys the report inspects. All optional strings. */
export interface BootCapabilityInput {
  AGENT_MODEL?: string | undefined;
  AGENT_FALLBACK_MODELS?: string | undefined;
  GOOGLE_GENERATIVE_AI_API_KEY?: string | undefined;
  OPENAI_API_KEY?: string | undefined;
  ANTHROPIC_API_KEY?: string | undefined;
  OPENROUTER_API_KEY?: string | undefined;
  COMPOSIO_API_KEY?: string | undefined;
  GMAIL_BACKEND?: string | undefined;
  CALENDAR_BACKEND?: string | undefined;
  LINKEDIN_BACKEND?: string | undefined;
  LINKEDIN_ACCESS_TOKEN?: string | undefined;
  LINKEDIN_AUTHOR_URN?: string | undefined;
  GITHUB_TOKEN?: string | undefined;
  FIRECRAWL_API_KEY?: string | undefined;
  CLAUDE_EXECUTOR_API_KEY?: string | undefined;
  LANGCHAIN_API_KEY?: string | undefined;
  LANGCHAIN_TRACING_V2?: string | undefined;
  OLLAMA_URL?: string | undefined;
  STORAGE_BUCKET?: string | undefined;
  AWS_ACCESS_KEY_ID?: string | undefined;
  AWS_SECRET_ACCESS_KEY?: string | undefined;
}

export interface CapabilityStatus {
  /** Human-readable capability name. */
  name: string;
  /** Whether the capability is configured (key/url present). */
  live: boolean;
  /** Extra context (e.g. fallback auth note). */
  detail: string;
}

const has = (v: string | undefined): boolean => typeof v === "string" && v.trim().length > 0;
const selectedModel = (env: BootCapabilityInput): string =>
  env.AGENT_MODEL?.trim() || "openrouter:openai/gpt-4o-mini";
const selectedProvider = (model: string): string => {
  if (model.includes(":")) return model.split(":", 1)[0]!;
  if (model.includes("gemini")) return "google-genai";
  if (model.includes("claude")) return "anthropic";
  return "openai";
};
const hasProviderKey = (env: BootCapabilityInput, provider: string): boolean => {
  if (provider === "google-genai") return has(env.GOOGLE_GENERATIVE_AI_API_KEY);
  if (provider === "anthropic") return has(env.ANTHROPIC_API_KEY);
  if (provider === "openrouter") return has(env.OPENROUTER_API_KEY);
  if (provider === "openai") return has(env.OPENAI_API_KEY);
  return false;
};

/**
 * Map env presence → capability statuses. Pure: no fs, no network, no globals.
 * NOTE: "live" means CONFIGURED (key present), not reachable. Reachability
 * (Postgres/Ollama up, OAuth valid) is asserted by the /health check + the
 * executor dual-auth verify step in DEPLOYMENT.md, not here.
 */
export function buildBootReport(env: BootCapabilityInput): CapabilityStatus[] {
  const model = selectedModel(env);
  const provider = selectedProvider(model);
  const modelLive = hasProviderKey(env, provider);
  const fallbackModels = env.AGENT_FALLBACK_MODELS?.trim();
  return [
    {
      name: "LLM (selected provider)",
      live: modelLive,
      detail: modelLive
        ? `${model} configured`
        : `no ${provider} key for ${model} — office is dead`,
    },
    {
      name: "LLM fallbacks",
      live: has(fallbackModels),
      detail: has(fallbackModels)
        ? `modelFallbackMiddleware armed: ${fallbackModels}`
        : "NO model fallback configured — set AGENT_FALLBACK_MODELS for cross-provider failover.",
    },
    {
      name: "Google Workspace (gws)",
      live: (env.GMAIL_BACKEND?.trim() || "gws") !== "composio" || has(env.COMPOSIO_API_KEY),
      detail: `GMAIL_BACKEND=${env.GMAIL_BACKEND?.trim() || "gws"} CALENDAR_BACKEND=${env.CALENDAR_BACKEND?.trim() || env.GMAIL_BACKEND?.trim() || "gws"} — gws requires CLI + auth on host`,
    },
    {
      name: "LinkedIn (direct API)",
      live:
        (env.LINKEDIN_BACKEND?.trim() || "direct") === "composio"
          ? has(env.COMPOSIO_API_KEY)
          : has(env.LINKEDIN_ACCESS_TOKEN) && has(env.LINKEDIN_AUTHOR_URN),
      detail:
        (env.LINKEDIN_BACKEND?.trim() || "direct") === "composio"
          ? has(env.COMPOSIO_API_KEY)
            ? "LINKEDIN_BACKEND=composio"
            : "set COMPOSIO_API_KEY or switch to direct"
          : has(env.LINKEDIN_ACCESS_TOKEN) && has(env.LINKEDIN_AUTHOR_URN)
            ? "LINKEDIN_ACCESS_TOKEN + AUTHOR_URN set"
            : "set LINKEDIN_ACCESS_TOKEN + LINKEDIN_AUTHOR_URN",
    },
    {
      name: "Composio (legacy fallback)",
      live: has(env.COMPOSIO_API_KEY),
      detail: has(env.COMPOSIO_API_KEY)
        ? "COMPOSIO_API_KEY set — rollback path available"
        : "not configured (expected when using gws + direct LinkedIn)",
    },
    {
      name: "GitHub tools",
      live: has(env.GITHUB_TOKEN),
      detail: has(env.GITHUB_TOKEN) ? "GITHUB_TOKEN set" : "engineering github_read/write disabled",
    },
    {
      name: "Web search (Firecrawl)",
      live: has(env.FIRECRAWL_API_KEY),
      detail: has(env.FIRECRAWL_API_KEY) ? "FIRECRAWL_API_KEY set" : "search_web falls back to keyless mode",
    },
    {
      name: "Claude executor",
      live: true, // OAuth (claude login) is the default path; key is an override.
      detail: has(env.CLAUDE_EXECUTOR_API_KEY) ? "API-key auth" : "OAuth/unset — verify with: claude -p \"hi\"",
    },
    {
      name: "Observability (LangSmith)",
      live: has(env.LANGCHAIN_API_KEY) && env.LANGCHAIN_TRACING_V2 === "true",
      detail:
        has(env.LANGCHAIN_API_KEY) && env.LANGCHAIN_TRACING_V2 === "true"
          ? "tracing on"
          : "tracing off (set LANGCHAIN_API_KEY + LANGCHAIN_TRACING_V2=true)",
    },
    {
      name: "RAG embeddings (Ollama)",
      live: has(env.OLLAMA_URL),
      detail: `endpoint ${env.OLLAMA_URL ?? "(unset)"} — liveness checked at query time`,
    },
    {
      name: "Image delivery storage (S3)",
      live:
        !has(env.GOOGLE_GENERATIVE_AI_API_KEY) ||
        (has(env.STORAGE_BUCKET) && has(env.AWS_ACCESS_KEY_ID) && has(env.AWS_SECRET_ACCESS_KEY)),
      detail: !has(env.GOOGLE_GENERATIVE_AI_API_KEY)
        ? "GOOGLE_GENERATIVE_AI_API_KEY unset — generate_image disabled, S3 not required"
        : has(env.STORAGE_BUCKET) && has(env.AWS_ACCESS_KEY_ID) && has(env.AWS_SECRET_ACCESS_KEY)
          ? `bucket=${env.STORAGE_BUCKET} — image delivery ready`
          : "GOOGLE_GENERATIVE_AI_API_KEY set but STORAGE_BUCKET/AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY missing — generate_image will succeed then fail at S3 upload. Set them (or STORAGE_ENDPOINT_URL for R2/MinIO) in PROD_DOTENV.",
    },
  ];
}

/** Log the boot report to journald. Warns loudly if a NON-optional cap is missing. */
export function logBootReport(env: BootCapabilityInput): void {
  const report = buildBootReport(env);
  for (const c of report) {
    const tag = c.live ? "LIVE " : "MISSING";
    const line = `[boot] ${c.name.padEnd(34)} ${tag}  ${c.detail}`;
    if (c.live) log.info(line);
    else log.warn(line);
  }
}
