/**
 * Vitest global test setup
 * Runs BEFORE any test file is loaded — sets required env vars so that
 * src/core/config.ts passes Zod validation without real credentials.
 *
 * Strategy:
 *   1. We manually parse .env from the project root and inject ONLY vars
 *      that are not already in process.env.  This means CI env vars always
 *      win, and on a local machine with a .env file, real API keys are used.
 *   2. We apply fallbacks using ||= (falsy check, not ??= nullish check).
 *
 * Why ||= and not ??= :
 *   ??= only replaces undefined/null — an empty-string value from .env slips through
 *   and then fails Zod's min(1) constraint.
 *   ||= replaces undefined, null, AND empty strings, so a blank .env entry always
 *   gets a safe stub for unit/integration tests.
 *   Real non-empty keys (e.g. AIza..., sk-or-...) are truthy — not replaced.
 *
 * This means:
 *   - Unit/integration tests: get fake stubs (fast, no real API calls needed)
 *   - Live tests: get real keys loaded from .env (hits real providers)
 */

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

// ── 1. Load .env into process.env (real keys win, stubs below are fallbacks) ──
const envPath = resolve(process.cwd(), ".env");
if (existsSync(envPath)) {
  const content = readFileSync(envPath, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    // Only inject if not already set by the shell environment
    if (key && val && !process.env[key]) {
      process.env[key] = val;
    }
  }
}

// ── 2. Minimal env var fallbacks (only if NOT already set or empty in .env) ───

process.env["NODE_ENV"] ||= "test";
process.env["DATABASE_URL"] ||= "postgresql://test:test@localhost:5432/founderos_test";
process.env["TELEGRAM_CHAT_ID"] ||= "-1001234567890";

// Fake stubs — only applied when real keys absent/empty (unit/integration tests don't need real keys)
process.env["TELEGRAM_BOT_TOKEN"] ||= "1234567890:test_bot_token_for_vitest";
process.env["ANTHROPIC_API_KEY"] ||= "sk-ant-test-key-for-vitest";
process.env["GOOGLE_GENERATIVE_AI_API_KEY"] ||= "test-google-key-for-vitest";

// Optional vars — set to avoid any conditional failures
process.env["LOG_LEVEL"] ||= "error"; // Suppress log noise in tests
process.env["LANGCHAIN_TRACING_V2"] ||= "false";
process.env["BUDGET_DAILY_USD"] ||= "999"; // Avoid budget checks blocking tests
