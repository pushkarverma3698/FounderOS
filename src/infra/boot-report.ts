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
  GOOGLE_GENERATIVE_AI_API_KEY?: string | undefined;
  OPENROUTER_API_KEY?: string | undefined;
  COMPOSIO_API_KEY?: string | undefined;
  GITHUB_TOKEN?: string | undefined;
  FIRECRAWL_API_KEY?: string | undefined;
  CLAUDE_EXECUTOR_API_KEY?: string | undefined;
  LANGCHAIN_API_KEY?: string | undefined;
  LANGCHAIN_TRACING_V2?: string | undefined;
  OLLAMA_URL?: string | undefined;
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

/**
 * Map env presence → capability statuses. Pure: no fs, no network, no globals.
 * NOTE: "live" means CONFIGURED (key present), not reachable. Reachability
 * (Postgres/Ollama up, OAuth valid) is asserted by the /health check + the
 * executor dual-auth verify step in DEPLOYMENT.md, not here.
 */
export function buildBootReport(env: BootCapabilityInput): CapabilityStatus[] {
  return [
    {
      name: "LLM (Gemini)",
      live: has(env.GOOGLE_GENERATIVE_AI_API_KEY),
      detail: has(env.GOOGLE_GENERATIVE_AI_API_KEY) ? "GOOGLE_GENERATIVE_AI_API_KEY set" : "no key — office is dead",
    },
    {
      name: "LLM fallback (OpenRouter)",
      live: has(env.OPENROUTER_API_KEY),
      detail: has(env.OPENROUTER_API_KEY)
        ? "cross-provider failover armed (GPT-4o-mini)"
        : "⚠ NO cross-provider failover — a Gemini quota/outage takes the whole office DOWN. Set OPENROUTER_API_KEY.",
    },
    {
      name: "Composio (email/linkedin/calendar)",
      live: has(env.COMPOSIO_API_KEY),
      detail: has(env.COMPOSIO_API_KEY) ? "COMPOSIO_API_KEY set" : "comms/marketing sends disabled",
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
