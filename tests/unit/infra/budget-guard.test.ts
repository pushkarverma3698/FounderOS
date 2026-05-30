/**
 * TDD — checkBudget fail-open behaviour.
 *
 * Tests:
 *   1. Spend < daily limit → resolves (allows call)
 *   2. Spend >= daily limit → throws budget error
 *   3. DB unavailable → assumes $0 spend (fail-open) → resolves
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Shared config mock (re-used across all tests here) ────────────────────────

vi.mock("../../../src/core/config.js", () => ({
  env: {
    ANTHROPIC_API_KEY: "sk-ant-test",
    GOOGLE_GENERATIVE_AI_API_KEY: "google-test",
    OPENROUTER_API_KEY: "sk-or-test",
    LM_STUDIO_URL: "http://localhost:1234",
    LM_STUDIO_MODEL: "test-model",
    BUDGET_DAILY_USD: 5.0,
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
  },
  CASCADE:                { md: [], ceo: [], nano: [], deep_research: [], code: [], critic: [], local: [], video: [] },
  CIRCUIT_BREAKER_OPTIONS: { timeout: 5000, errorThresholdPercentage: 50, resetTimeout: 30000, volumeThreshold: 3 },
  RATE_LIMITER_OPTIONS:    { maxConcurrent: 5, minTime: 0 },
  TIER_MAX_TOKENS:         { md: 2048, ceo: 512, nano: 256, deep_research: 4096, code: 4096, critic: 1024, local: 1024, video: 256 },
  MODEL_COST_PER_1M:       {},
}));

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("checkBudget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves when today's spend is below the daily limit", async () => {
    vi.doMock("../../../src/db/queries.js", () => ({
      getTodayCostUsd:  vi.fn().mockResolvedValue(2.50), // $2.50 < $5.00
      logLlmCost:       vi.fn().mockResolvedValue(undefined),
    }));

    const { checkBudget } = await import("../../../src/infra/llm.js");

    // Should not throw
    await expect(checkBudget("turicks")).resolves.toBeUndefined();
  });

  it("throws when today's spend meets or exceeds the daily limit", async () => {
    vi.doMock("../../../src/db/queries.js", () => ({
      getTodayCostUsd:  vi.fn().mockResolvedValue(5.00), // $5.00 === $5.00 limit
      logLlmCost:       vi.fn().mockResolvedValue(undefined),
    }));

    vi.resetModules();
    // Re-import after resetting mocks
    vi.doMock("../../../src/core/config.js", () => ({
      env: {
        BUDGET_DAILY_USD: 5.0,
        NODE_ENV: "test",
        LOG_LEVEL: "silent",
        LM_STUDIO_URL: "http://localhost:1234",
      },
      CASCADE: { md: [], ceo: [], nano: [], deep_research: [], code: [], critic: [], local: [], video: [] },
      CIRCUIT_BREAKER_OPTIONS: { timeout: 5000, errorThresholdPercentage: 50, resetTimeout: 30000, volumeThreshold: 3 },
      RATE_LIMITER_OPTIONS: { maxConcurrent: 5, minTime: 0 },
      TIER_MAX_TOKENS: { md: 2048, ceo: 512, nano: 256, deep_research: 4096, code: 4096, critic: 1024, local: 1024, video: 256 },
      MODEL_COST_PER_1M: {},
    }));

    vi.doMock("../../../src/db/queries.js", () => ({
      getTodayCostUsd: vi.fn().mockResolvedValue(5.00),
      logLlmCost: vi.fn().mockResolvedValue(undefined),
    }));

    const { checkBudget } = await import("../../../src/infra/llm.js");
    await expect(checkBudget("turicks")).rejects.toThrow(/Budget exceeded/i);
  });

  it("resolves (fail-open) when DB is unavailable — assumes $0 spend", async () => {
    vi.resetModules();

    vi.doMock("../../../src/core/config.js", () => ({
      env: {
        BUDGET_DAILY_USD: 5.0,
        NODE_ENV: "test",
        LOG_LEVEL: "silent",
        LM_STUDIO_URL: "http://localhost:1234",
      },
      CASCADE: { md: [], ceo: [], nano: [], deep_research: [], code: [], critic: [], local: [], video: [] },
      CIRCUIT_BREAKER_OPTIONS: { timeout: 5000, errorThresholdPercentage: 50, resetTimeout: 30000, volumeThreshold: 3 },
      RATE_LIMITER_OPTIONS: { maxConcurrent: 5, minTime: 0 },
      TIER_MAX_TOKENS: { md: 2048, ceo: 512, nano: 256, deep_research: 4096, code: 4096, critic: 1024, local: 1024, video: 256 },
      MODEL_COST_PER_1M: {},
    }));

    vi.doMock("../../../src/db/queries.js", () => ({
      getTodayCostUsd: vi.fn().mockRejectedValue(new Error("ECONNREFUSED — DB unavailable")),
      logLlmCost: vi.fn().mockResolvedValue(undefined),
    }));

    const { checkBudget } = await import("../../../src/infra/llm.js");

    // DB is down — should NOT throw (fail-open)
    await expect(checkBudget("turicks")).resolves.toBeUndefined();
  });
});
