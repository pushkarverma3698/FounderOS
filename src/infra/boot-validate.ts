/**
 * FounderOS — Strict Boot Validation
 * ===================================
 * `config.ts` validates env *presence* (Zod) and `boot-report.ts` LOGS what is
 * LIVE vs MISSING — but neither stops a boot that will be silently half-dead.
 * The canonical incident: the bot booted "fine" on a selected LLM provider with
 * no matching key, then failed every turn in production.
 *
 * This module asserts the invariants that must hold for the bot to do real work,
 * and THROWS at boot if they don't — converting a production-only failure into a
 * loud, immediate startup error (CLAUDE.md rule #19.5: fail loud, fail safe).
 *
 * Pure: env in → report out. `assertBootConfigOrThrow` is the only side effect
 * (it throws). Wired into src/index.ts before the office compiles.
 */

import { buildBootReport, type BootCapabilityInput } from "./boot-report.js";

export interface BootValidationInput extends BootCapabilityInput {
  DATABASE_URL?: string | undefined;
  TELEGRAM_BOT_TOKEN?: string | undefined;
  TELEGRAM_CHAT_ID?: string | undefined;
}

export interface BootValidation {
  errors: string[];
  warnings: string[];
}

const present = (v: string | undefined): boolean => typeof v === "string" && v.trim().length > 0;

/** Telegram bot tokens are `<digits>:<rest>`; a malformed one 401s and crashes polling. */
const TELEGRAM_TOKEN_SHAPE = /^\d+:[A-Za-z0-9_-]+$/;

/**
 * Validate the runtime config needed for the bot to actually function.
 * Returns ALL problems (does not throw) so every misconfig is visible at once.
 *
 *   ERROR   — the bot would be silently broken (dead LLM, no DB, no Telegram).
 *   WARNING — degraded but functional (no failover, optional integration off).
 */
export function validateBootConfig(env: BootValidationInput): BootValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  // ── LLM: the selected provider MUST have a matching key (else office is dead) ─
  const report = buildBootReport(env);
  const llm = report.find((c) => c.name === "LLM (selected provider)");
  if (llm && !llm.live) {
    errors.push(`LLM provider not configured: ${llm.detail}. The office cannot route a single turn.`);
  }
  const fallback = report.find((c) => c.name === "LLM fallbacks");
  if (fallback && !fallback.live) {
    warnings.push("No LLM fallback configured — a provider outage/quota takes the whole office down. Set AGENT_FALLBACK_MODELS.");
  }

  // ── Database: required for the checkpointer + audit log ──────────────────────
  if (!present(env.DATABASE_URL)) {
    errors.push("DATABASE_URL is not set — the LangGraph checkpointer and audit log cannot start.");
  } else if (
    env.DATABASE_URL!.includes("://postgres:") ||
    env.DATABASE_URL!.startsWith("postgresql://postgres@")
  ) {
    errors.push("DATABASE_URL uses the 'postgres' superuser — FounderOS expects its own role (e.g. turicks/founderos).");
  }

  // ── Telegram: required transport ─────────────────────────────────────────────
  if (!present(env.TELEGRAM_BOT_TOKEN)) {
    errors.push("TELEGRAM_BOT_TOKEN is not set — the gateway cannot start.");
  } else if (!TELEGRAM_TOKEN_SHAPE.test(env.TELEGRAM_BOT_TOKEN!.trim())) {
    warnings.push("TELEGRAM_BOT_TOKEN is not in '<digits>:<token>' shape — long-polling will 401 and crash. Verify the BotFather token.");
  }
  if (!present(env.TELEGRAM_CHAT_ID)) {
    errors.push("TELEGRAM_CHAT_ID is not set — startup notifications and HITL cards have no destination.");
  }

  // ── Optional integrations: degraded, not fatal ──────────────────────────────
  for (const name of ["Composio (email/linkedin/calendar)", "GitHub tools"]) {
    const cap = report.find((c) => c.name === name);
    if (cap && !cap.live) warnings.push(`${name} not configured — ${cap.detail}.`);
  }

  return { errors, warnings };
}

/**
 * Throw a single aggregated error if the boot config has any fatal problem.
 * Call this at startup BEFORE compiling the office so a misconfig fails loud and
 * early instead of mid-turn in production.
 */
export function assertBootConfigOrThrow(env: BootValidationInput): BootValidation {
  const result = validateBootConfig(env);
  if (result.errors.length > 0) {
    throw new Error(
      `Boot validation failed (${result.errors.length} fatal config error(s)):\n- ${result.errors.join("\n- ")}`,
    );
  }
  return result;
}
