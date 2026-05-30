/**
 * CHAOS — All providers fail simultaneously.
 *
 * This test suite verifies P4-HARD-1: pod nodes must catch AggregateError
 * from callCascade and return error state instead of crashing the graph.
 *
 * TDD RED: These tests FAIL before P4-HARD-1 (no try-catch in pod nodes).
 * TDD GREEN: Pass after adding try-catch to leadIntelNode + salesEngineerNode etc.
 *
 * Tests:
 *   1. Pod node catches AggregateError → returns state with errors[] populated
 *   2. Graph continues after node error (does not crash)
 *   3. errors[] array accumulates the failure record
 *   4. Returned state still has all original fields (no undefined spread)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";

// ── Module mocks ──────────────────────────────────────────────────────────────

const ALL_FAILING_CASCADE = vi.fn().mockRejectedValue(
  new AggregateError(
    [
      new Error("anthropic:claude-sonnet-4-5: HTTP 503"),
      new Error("google:gemini-2.5-flash: HTTP 429"),
      new Error("openrouter:llama-3.3-70b: ECONNREFUSED"),
    ],
    'All cascade entries for tier "deep_research" failed',
  ),
);

vi.mock("../../src/infra/llm.js", () => ({
  callCascade:    ALL_FAILING_CASCADE,
  checkBudget:    vi.fn().mockResolvedValue(undefined),
  safeParseJson:  vi.fn().mockReturnValue(null),
  runPlanner:     vi.fn().mockRejectedValue(new Error("not used")),
  runToolExecutor: vi.fn().mockRejectedValue(new Error("not used")),
}));

vi.mock("../../src/db/queries.js", () => ({
  hasBeenAudited:   vi.fn().mockResolvedValue(false),
  writeAuditEntry:  vi.fn().mockResolvedValue(undefined),
  isSuppressed:     vi.fn().mockResolvedValue(false),
  logLlmCost:       vi.fn().mockResolvedValue(undefined),
  getTodayCostUsd:  vi.fn().mockResolvedValue(0),
  createInterruptRecord: vi.fn().mockResolvedValue({ id: "test-id" }),
  updateInterruptStatus: vi.fn().mockResolvedValue(undefined),
  getInterruptRecord:    vi.fn().mockResolvedValue(null),
  writeTaskOutcome:      vi.fn().mockResolvedValue(undefined),
  getRecentOutcomes:     vi.fn().mockResolvedValue([]),
  publishDeptEvent:      vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/infra/redis.js", () => ({
  incrQuota: vi.fn().mockResolvedValue(1),
  cacheGet:  vi.fn().mockResolvedValue(null),
  cacheSet:  vi.fn().mockResolvedValue(undefined),
  getQuota:  vi.fn().mockResolvedValue(0),
  KEYS: {
    research: (u: string) => `research:${u}`,
    quota: (t: string, d: string) => `quota:${t}:${d}`,
    llmCache: (h: string) => `llm:${h}`,
  },
  hashPrompt: vi.fn().mockReturnValue("test-hash"),
  todayUtc: vi.fn().mockReturnValue("2026-05-30"),
  tomorrowMidnightUtc: vi.fn().mockReturnValue(9999999999),
}));

vi.mock("../../src/gateway/hitl.js", () => ({
  requestHITL: vi.fn().mockResolvedValue({
    interrupt_id: "test-interrupt",
    status: "pending",
    requested_at: new Date().toISOString(),
  }),
}));

vi.mock("../../src/core/config.js", () => ({
  env: {
    ANTHROPIC_API_KEY: "sk-ant-test",
    GOOGLE_GENERATIVE_AI_API_KEY: "google-test",
    OPENROUTER_API_KEY: "sk-or-test",
    BUDGET_DAILY_USD: 999,
    DAILY_SEND_LIMIT: 10,
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    LM_STUDIO_URL: "http://localhost:1234",
    LM_STUDIO_MODEL: "test-model",
    TELEGRAM_BOT_TOKEN: "123456:test",
    TELEGRAM_CHAT_ID: "-100123",
    TOPIC_BOARDROOM: 0,
  },
  CASCADE: {
    md: [],
    ceo: [],
    nano: [],
    deep_research: [],
    code: [],
    critic: [],
    local: [],
    video: [],
  },
  CIRCUIT_BREAKER_OPTIONS: { timeout: 5000, errorThresholdPercentage: 50, resetTimeout: 30000, volumeThreshold: 3 },
  RATE_LIMITER_OPTIONS: { maxConcurrent: 5, minTime: 0 },
  TIER_MAX_TOKENS: { md: 2048, ceo: 512, nano: 256, deep_research: 4096, code: 4096, critic: 1024, local: 1024, video: 256 },
  MODEL_COST_PER_1M: {},
  LLM_CACHE_TTL: { ceo: 0, md: 3600, nano: 86400 },
  RESEARCH_CACHE_TTL_SECONDS: 604800,
}));

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("P4-HARD-1 — pod nodes survive AggregateError from callCascade", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ALL_FAILING_CASCADE.mockRejectedValue(
      new AggregateError(
        [new Error("all providers failed")],
        'All cascade entries for tier "deep_research" failed',
      ),
    );
  });

  it("sales pod leadIntelNode does not throw when callCascade throws AggregateError", async () => {
    const { salesSubgraph } = await import("../../src/agents/pods/sales.js");

    // Run the sales pod — leadIntelNode is the first node and will fail
    // P4-HARD-1 FIX: it should return error state, not throw
    const result = await salesSubgraph.invoke({
      task: "Research prospect: Gymshark",
      tenant_id: "turicks",
    });

    // After P4-HARD-1 fix: result should exist (not thrown)
    expect(result).toBeDefined();
    // errors[] should be populated with the failure
    expect(Array.isArray(result.errors)).toBe(true);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("errors array contains the AggregateError details when cascade fails", async () => {
    const { salesSubgraph } = await import("../../src/agents/pods/sales.js");

    const result = await salesSubgraph.invoke({
      task: "Research prospect: Gymshark",
      tenant_id: "turicks",
    });

    // Each error record should have agent and err fields
    const firstError = result.errors[0] as Record<string, unknown>;
    expect(firstError).toHaveProperty("agent");
    expect(firstError).toHaveProperty("err");
  });

  it("graph state fields are intact after cascade failure (no undefined spread)", async () => {
    const { salesSubgraph } = await import("../../src/agents/pods/sales.js");

    const result = await salesSubgraph.invoke({
      task: "Research prospect: Gymshark",
      tenant_id: "turicks",
      trace_id: "test-trace-123",
    });

    // Original fields must survive error path
    expect(result.tenant_id).toBe("turicks");
    expect(result.task).toBe("Research prospect: Gymshark");
  });
});
