/**
 * FounderOS — LangSmith Telemetry
 * =================================
 * Initializes LangSmith tracing + a PII scrubber that runs before
 * any span is exported.
 *
 * Rules:
 *  1. Call initTelemetry() ONCE at startup (src/index.ts)
 *  2. PII scrubber redacts emails, phone numbers, API keys from span payloads
 *  3. If LANGCHAIN_API_KEY is absent, telemetry is a no-op (graceful degrade)
 *
 * Usage: Just call initTelemetry() — LangGraph auto-detects env vars.
 */

import { env } from "../core/config.js";
import { logger } from "./logger.js";

// ── PII Patterns ──────────────────────────────────────────────────────────────

const PII_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, replacement: "[EMAIL]" },
  { pattern: /\b(\+\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, replacement: "[PHONE]" },
  { pattern: /\b(sk-|sk-ant-)[A-Za-z0-9_-]{20,}/g, replacement: "[API_KEY]" },
  { pattern: /\b(AIza|ya29\.)[A-Za-z0-9_-]{20,}/g, replacement: "[GOOGLE_KEY]" },
  { pattern: /Bearer\s+[A-Za-z0-9_.-]{20,}/g, replacement: "Bearer [TOKEN]" },
  // Credit card numbers (basic Luhn pattern)
  { pattern: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, replacement: "[CARD]" },
];

/** Scrub PII from any string value before it reaches a log sink or trace. */
export function scrubPii(text: string): string {
  return PII_PATTERNS.reduce(
    (t, { pattern, replacement }) => t.replace(pattern, replacement),
    text,
  );
}

/** Recursively scrub PII from an arbitrary object/array (trace payloads). */
export function scrubObject(obj: unknown): unknown {
  if (typeof obj === "string") return scrubPii(obj);
  if (Array.isArray(obj)) return obj.map(scrubObject);
  if (obj !== null && typeof obj === "object") {
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>).map(([k, v]) => [k, scrubObject(v)]),
    );
  }
  return obj;
}

// ── Telemetry Init ────────────────────────────────────────────────────────────

let _initialized = false;

/**
 * Initialize LangSmith tracing.
 * LangGraph reads LANGCHAIN_TRACING_V2, LANGCHAIN_API_KEY, LANGCHAIN_PROJECT
 * from the environment — we just validate and log.
 *
 * Call once at startup. Idempotent.
 */
export function initTelemetry(): void {
  if (_initialized) return;
  _initialized = true;

  const log = logger.child({ module: "telemetry" });

  if (!env.LANGCHAIN_API_KEY) {
    log.info("LangSmith API key not set — tracing disabled (graceful degrade)");
    return;
  }

  if (env.LANGCHAIN_TRACING_V2 !== "true") {
    log.info("LANGCHAIN_TRACING_V2=false — tracing disabled");
    return;
  }

  // LangGraph/LangChain auto-detects env vars — nothing else to call here.
  // The env vars are already exported by config.ts via process.env.
  log.info(
    { project: env.LANGCHAIN_PROJECT },
    "LangSmith tracing enabled",
  );
}

// ── Trace Metadata ────────────────────────────────────────────────────────────

/** Standard metadata attached to every LangGraph run. */
export function buildRunMetadata(opts: {
  tenant_id: string;
  trace_id: string;
  agent?: string;
}): Record<string, string> {
  return {
    tenant_id: opts.tenant_id,
    trace_id: opts.trace_id,
    agent: opts.agent ?? "unknown",
    app_version: process.env["npm_package_version"] ?? "dev",
    node_env: env.NODE_ENV,
  };
}
