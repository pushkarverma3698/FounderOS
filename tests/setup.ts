/**
 * Vitest global test setup
 * Runs BEFORE any test file is loaded — sets required env vars so that
 * src/core/config.ts passes Zod validation without real credentials.
 */

// ── Minimal env vars required by src/core/config.ts ──────────────────────────

process.env["NODE_ENV"] = "test";
process.env["DATABASE_URL"] = "postgresql://test:test@localhost:5432/founderos_test";
process.env["TELEGRAM_BOT_TOKEN"] = "1234567890:test_bot_token_for_vitest";
process.env["TELEGRAM_CHAT_ID"] = "-1001234567890";
process.env["ANTHROPIC_API_KEY"] = "sk-ant-test-key-for-vitest";
process.env["GOOGLE_GENERATIVE_AI_API_KEY"] = "test-google-key-for-vitest";

// Optional vars — set to avoid any conditional failures
process.env["LOG_LEVEL"] = "error"; // Suppress log noise in tests
process.env["LANGCHAIN_TRACING_V2"] = "false";
process.env["BUDGET_DAILY_USD"] = "999"; // Avoid budget checks blocking tests
