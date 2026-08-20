/**
 * FounderOS — LangSmith telemetry gate
 * =====================================
 * This file used to claim, in this header, that it installed "a PII scrubber
 * that runs before any span is exported" and that the scrubber "redacts emails,
 * phone numbers, API keys from span payloads". **Neither was true.**
 * `initTelemetry()` only logged. `scrubPii`/`scrubObject` had exactly one
 * consumer — `src/infra/trace.ts:89`, the LOCAL pino path — and were never
 * attached to any exporter. A documented safety guarantee with no mechanism
 * behind it is the failure class CLAUDE.md #27 names, and the same one
 * `src/infra/health-api-stubs.ts` was written to close.
 *
 * Why it mattered: when `LANGCHAIN_TRACING_V2=true`, LangChain reads that
 * variable from `process.env` ITSELF and exports full run I/O — prompts, tool
 * inputs and outputs, model responses — to LangSmith. For FounderOS that
 * payload is the founder's email bodies, CV, recruiter addresses and job
 * applications, leaving the box to a third party, under a header saying they
 * were scrubbed. `.env.example` invites the flip ("Set to 'true' to enable
 * LangSmith trace upload") with no such warning.
 *
 * Why there is no scrubber instead of a claim of one: langsmith 0.2.15 exposes
 * `anonymizer` / `hideInputs` / `hideOutputs` ONLY as `Client` constructor
 * options (`node_modules/langsmith/dist/client.d.ts:10-11`), with no env-var
 * equivalent, and LangChain's auto-tracing path constructs its own `Client`.
 * Installing a scrubbing client globally would mean reaching into LangChain
 * tracer internals — version-coupled, and unprovable from here. An unverifiable
 * scrubber is exactly the thing this header used to be.
 *
 * So the gate is honest instead: export is REFUSED unless the operator opts in
 * explicitly, and refusing means removing the variables from `process.env` —
 * not merely logging "disabled", which LangChain would ignore. That distinction
 * is the whole point: a log line that says export is off, while export is on,
 * would recreate the original bug in a new place.
 *
 * NOTE — scrubbing what we SEND to the model is deliberately NOT done, and is
 * not a gap. The agent must see `alex@acme.com` to email Alex. Redacting model
 * input would break the product to protect nothing: the model provider is a
 * required processor, not an incidental exporter. The boundary worth guarding
 * is the optional third-party observability export, which is what this gate is.
 *
 * Rules:
 *  1. Call initTelemetry() ONCE at startup, BEFORE the kernel boots
 *     (src/index.ts:47 runs before getKernel() on :58 — keep that order).
 *  2. `scrubPii` / `scrubObject` protect the LOCAL log + trace path only.
 *  3. No LANGCHAIN_API_KEY → no-op (graceful degrade).
 *  4. Tracing requested without ACCEPT_UNSCRUBBED_EXPORT → refused, loudly.
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

/**
 * Scrub PII from any string value before it reaches a LOCAL log sink or trace.
 *
 * This is NOT wired to any third-party exporter — see the module header. Do not
 * cite it as evidence that exported spans are scrubbed; they are not, which is
 * why `assertExportAllowed` refuses the export instead.
 */
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
 * The explicit opt-in. Read from `process.env` at call time rather than from
 * the frozen `env` object, for the same reason `SKILL_SYNTHESIS_ENABLED` is
 * (src/gateway/kernel-boot.ts:100): a security gate nobody can test both ways
 * is a gate nobody can prove is closed.
 */
export const ACCEPT_UNSCRUBBED_ENV = "LANGSMITH_ACCEPT_UNSCRUBBED_EXPORT";

/**
 * Every variable LangChain or the langsmith SDK reads to decide whether to
 * upload spans. Refusing the export means clearing ALL of them — clearing only
 * the one we happen to validate would leave a second door open.
 */
export const TRACING_ENV_VARS: readonly string[] = [
  "LANGCHAIN_TRACING_V2",
  "LANGCHAIN_TRACING",
  "LANGSMITH_TRACING",
  "LANGSMITH_TRACING_V2",
];

export type ExportDecision = {
  /** Whether span upload to LangSmith may proceed. */
  allowed: boolean;
  /** Whether the tracing env vars must be cleared to make `allowed:false` real. */
  strip: boolean;
  /** Operator-facing explanation. Always present — silence is never the answer. */
  reason: string;
  level: "info" | "error";
};

/**
 * Pure gate. Decides whether unscrubbed span export may proceed.
 *
 * `strip` is the load-bearing field: when tracing was REQUESTED and refused,
 * logging alone changes nothing, because LangChain reads the variable itself.
 * The refusal is only real once the variables are gone from `process.env`.
 */
export function decideExport(opts: {
  apiKey?: string | undefined;
  tracingRequested: boolean;
  accepted?: string | undefined;
}): ExportDecision {
  if (!opts.tracingRequested) {
    return {
      allowed: false,
      strip: false,
      level: "info",
      reason: "LangSmith tracing not requested — no span export.",
    };
  }

  if (!opts.apiKey) {
    return {
      allowed: false,
      strip: true,
      level: "error",
      reason:
        "LangSmith tracing requested but LANGCHAIN_API_KEY is unset. Tracing env vars cleared so the SDK cannot retry an unauthenticated upload.",
    };
  }

  if (opts.accepted !== "true") {
    return {
      allowed: false,
      strip: true,
      level: "error",
      reason:
        `REFUSED: LangSmith export would upload full run I/O — prompts, tool inputs and outputs, model replies — to a third party. ` +
        `For FounderOS that is the founder's email bodies, CV, recruiter addresses and job applications. ` +
        `Nothing scrubs it: langsmith 0.2.15 accepts an anonymizer only as a Client constructor option, and LangChain builds its own Client. ` +
        `Tracing env vars have been cleared. To accept that trade deliberately, set ${ACCEPT_UNSCRUBBED_ENV}=true.`,
    };
  }

  return {
    allowed: true,
    strip: false,
    level: "error",
    reason:
      `LangSmith export ENABLED and payloads are NOT scrubbed (${ACCEPT_UNSCRUBBED_ENV}=true). ` +
      `Prompts, tool I/O and model replies leave this box in full.`,
  };
}

/**
 * Apply the export gate. Call ONCE at startup, before the kernel boots.
 * Idempotent.
 */
export function initTelemetry(): void {
  if (_initialized) return;
  _initialized = true;

  const log = logger.child({ module: "telemetry" });

  const decision = decideExport({
    apiKey: env.LANGCHAIN_API_KEY,
    tracingRequested: env.LANGCHAIN_TRACING_V2 === "true",
    accepted: process.env[ACCEPT_UNSCRUBBED_ENV],
  });

  if (decision.strip) {
    for (const key of TRACING_ENV_VARS) delete process.env[key];
  }

  log[decision.level](
    { project: env.LANGCHAIN_PROJECT, allowed: decision.allowed, stripped: decision.strip },
    decision.reason,
  );
}

// ── Trace Metadata ────────────────────────────────────────────────────────────

/** Standard metadata attached to every LangGraph run. */
export function buildRunMetadata(opts: {
  tenant_id: string;
  trace_id: string;
  agent?: string;
  prompt_hash?: string;
}): Record<string, string> {
  return {
    tenant_id: opts.tenant_id,
    trace_id: opts.trace_id,
    agent: opts.agent ?? "unknown",
    prompt_hash: opts.prompt_hash ?? "none",
    app_version: process.env["npm_package_version"] ?? "dev",
    node_env: env.NODE_ENV,
  };
}
