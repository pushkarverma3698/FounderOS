/**
 * FounderOS — Structured Logger
 * ==============================
 * Pino-based logger with:
 *  - JSON output in production
 *  - Pretty-print in development
 *  - Child loggers with bound context (tenant_id, agent, trace_id)
 *  - PII fields stripped before any log sink
 *
 * Usage:
 *   import { logger } from "./infra/logger.js";
 *   const log = logger.child({ agent: "lead_intel", tenant_id: "turicks" });
 *   log.info({ icp_score: 0.9 }, "Lead qualified");
 */

import pino from "pino";
import { env } from "../core/config.js";

// ── PII field scrubbing ───────────────────────────────────────────────────────

/**
 * Fields redacted from all log output.
 * Extend this list as new PII fields are added to state shapes.
 */
const PII_FIELDS = [
  "email",
  "phone",
  "password",
  "api_key",
  "token",
  "secret",
  "authorization",
  "cookie",
  "credit_card",
  "ssn",
  // LLM message content — full text goes to LangSmith, not plain logs
  "messages",
  "content",
] as const;

// ── Logger factory ────────────────────────────────────────────────────────────

const isDev = env.NODE_ENV === "development";

// The stdio MCP server (src/mcp/index.ts, `pnpm mcp`) speaks JSON-RPC on stdout,
// so ANY log line on stdout corrupts the protocol stream. When LOG_STDERR=1 the
// logger writes to stderr (fd 2) instead, keeping stdout pure for that entry.
// Default (unset) stays stdout so prod log aggregation is unchanged. Must be set
// in the environment BEFORE this module loads — the `mcp` npm script does exactly
// that, as does the .mcp.json ssh command in docs/VPS-MCP-SETUP.md.
const toStderr = process.env["LOG_STDERR"] === "1";

export const logger = pino(
  {
    level: env.LOG_LEVEL,

    // Redact PII — nested paths with wildcard
    redact: {
      paths: [
        ...PII_FIELDS,
        ...PII_FIELDS.map((f) => `*.${f}`),
        ...PII_FIELDS.map((f) => `**.${f}`),
      ],
      censor: "[REDACTED]",
    },

    // Pretty-print in dev, raw JSON in prod (picked up by log aggregators).
    transport: isDev
      ? {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "HH:MM:ss",
            ignore: "pid,hostname",
            // fd 2 = stderr when LOG_STDERR=1 (keeps stdio-MCP stdout clean).
            ...(toStderr ? { destination: 2 } : {}),
          },
        }
      : undefined,

    // Standard fields on every log line
    base: {
      app: "founderos",
      env: env.NODE_ENV,
    },

    // ISO timestamp
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  // In prod (no pino-pretty transport) route the raw stream to stderr directly.
  toStderr && !isDev ? pino.destination(2) : undefined,
);

// ── Typed child-logger helpers ────────────────────────────────────────────────

export interface LogContext {
  module?: string;
  agent?: string;
  tenant_id?: string;
  trace_id?: string;
  tier?: string;
  model?: string;
}

/** Create a child logger with bound context — zero-cost if level not active. */
export function childLogger(ctx: LogContext): pino.Logger {
  return logger.child(ctx);
}

/** Convenience: log an error with stack trace and structured context. */
export function logError(
  log: pino.Logger,
  err: unknown,
  ctx: Record<string, unknown> = {},
): void {
  if (err instanceof Error) {
    log.error({ ...ctx, err: { message: err.message, stack: err.stack } }, err.message);
  } else {
    log.error({ ...ctx, err }, "Unknown error");
  }
}
