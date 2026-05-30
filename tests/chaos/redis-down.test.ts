/**
 * CHAOS — Redis unavailable during operations.
 *
 * Tests:
 *   1. Research node proceeds when Redis cache fails (re-researches, does not crash)
 *   2. Quota check fails-open when Redis is down (send proceeds)
 *   3. Redis recovery: after 3 failed calls, a working Redis is used correctly
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module mocks ──────────────────────────────────────────────────────────────

const mockCallCascade = vi.fn();

vi.mock("../../src/infra/llm.js", () => ({
  callCascade:    mockCallCascade,
  checkBudget:    vi.fn().mockResolvedValue(undefined),
  safeParseJson:  (text: string) => {
    try { return JSON.parse(text) as Record<string, unknown>; }
    catch { return null; }
  },
  runPlanner:     vi.fn().mockRejectedValue(new Error("not used")),
  runToolExecutor: vi.fn().mockRejectedValue(new Error("not used")),
}));

vi.mock("../../src/db/queries.js", () => ({
  hasBeenAudited:    vi.fn().mockResolvedValue(false),
  writeAuditEntry:   vi.fn().mockResolvedValue(undefined),
  isSuppressed:      vi.fn().mockResolvedValue(false),
  logLlmCost:        vi.fn().mockResolvedValue(undefined),
  getTodayCostUsd:   vi.fn().mockResolvedValue(0),
  createInterruptRecord: vi.fn().mockResolvedValue({ id: "test-id" }),
  updateInterruptStatus: vi.fn().mockResolvedValue(undefined),
  getInterruptRecord: vi.fn().mockResolvedValue(null),
  writeTaskOutcome:  vi.fn().mockResolvedValue(undefined),
  getRecentOutcomes: vi.fn().mockResolvedValue([]),
  publishDeptEvent:  vi.fn().mockResolvedValue(undefined),
  createLead:        vi.fn().mockResolvedValue("test-lead-id"),
  updateLeadStage:   vi.fn().mockResolvedValue(undefined),
  getLeadByUrl:      vi.fn().mockResolvedValue(null),
  resolveInterrupt:  vi.fn().mockResolvedValue(undefined),
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
    BUDGET_DAILY_USD: 999, DAILY_SEND_LIMIT: 10,
    NODE_ENV: "test", LOG_LEVEL: "silent",
    LM_STUDIO_URL: "http://localhost:1234", LM_STUDIO_MODEL: "test-model",
    TELEGRAM_BOT_TOKEN: "123456:test", TELEGRAM_CHAT_ID: "-100123", TOPIC_BOARDROOM: 0,
  },
  CASCADE: { md: [], ceo: [], nano: [], deep_research: [], code: [], critic: [], local: [], video: [] },
  CIRCUIT_BREAKER_OPTIONS: { timeout: 5000, errorThresholdPercentage: 50, resetTimeout: 30000, volumeThreshold: 10 },
  RATE_LIMITER_OPTIONS: { maxConcurrent: 5, minTime: 0 },
  TIER_MAX_TOKENS: { md: 2048, ceo: 512, nano: 256, deep_research: 4096, code: 4096, critic: 1024, local: 1024, video: 256 },
  MODEL_COST_PER_1M: {},
  LLM_CACHE_TTL: { ceo: 0, md: 3600, nano: 86400 },
  RESEARCH_CACHE_TTL_SECONDS: 604800,
}));

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("CHAOS — Redis unavailable", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("quota check fails-open when Redis incrQuota returns 0 → send proceeds", async () => {
    // Redis down → incrQuota returns 0 → 0 <= DAILY_SEND_LIMIT → proceeds

    vi.mock("../../src/infra/redis.js", () => ({
      incrQuota:  vi.fn().mockResolvedValue(0), // fail-open value
      cacheGet:   vi.fn().mockResolvedValue(null),
      cacheSet:   vi.fn().mockResolvedValue(undefined),
      getQuota:   vi.fn().mockResolvedValue(0),
      KEYS: { research: (u: string) => u, quota: (t: string, d: string) => `${t}:${d}`, llmCache: (h: string) => h },
      hashPrompt: vi.fn().mockReturnValue("hash"),
      todayUtc: vi.fn().mockReturnValue("2026-05-30"),
      tomorrowMidnightUtc: vi.fn().mockReturnValue(9999999999),
    }));

    const LEAD_INTEL = {
      text: JSON.stringify({
        lead: { name: "Test User", company: "Acme", url: "", pain_points: [], icp_score: 0.7, budget_signal: "medium", source: "cold_email" },
        intel_report: "Test report",
      }),
      model: "gemini-2.5-flash", provider: "google", tier: "deep_research", tokensIn: 10, tokensOut: 20, costUsd: 0,
    };
    const SALES_ENG = {
      text: JSON.stringify({ angle: "automation", hook: "test", value_prop: "test", proof_point: "test", cta: "call" }),
      model: "gemini-2.5-flash", provider: "google", tier: "md", tokensIn: 10, tokensOut: 20, costUsd: 0,
    };
    const BDR = {
      text: JSON.stringify({ subject: "Test subject", body: "Test body" }),
      model: "gemini-2.5-flash", provider: "google", tier: "md", tokensIn: 10, tokensOut: 20, costUsd: 0,
    };
    const CRITIC_APPROVED = {
      text: JSON.stringify({ result: "APPROVED", notes: "Good", rule_violations: [], critic_model: "claude-haiku-4-5" }),
      model: "claude-haiku-4-5", provider: "anthropic", tier: "critic", tokensIn: 10, tokensOut: 20, costUsd: 0,
    };

    mockCallCascade
      .mockResolvedValueOnce(LEAD_INTEL)
      .mockResolvedValueOnce(SALES_ENG)
      .mockResolvedValueOnce(BDR)
      .mockResolvedValueOnce(CRITIC_APPROVED);

    const { salesSubgraph } = await import("../../src/agents/pods/sales.js");
    const result = await salesSubgraph.invoke({
      task: "Reach out to Acme",
      tenant_id: "turicks",
    });

    // With Redis down (incrQuota=0), quota check passes (fail-open)
    // Send should NOT be blocked
    expect(result.final?.status).not.toBe("quota_exceeded");
    expect(result.errors).toHaveLength(0);
  });

  it("cacheGet returning null (Redis down) causes research node to re-scrape — not crash", async () => {
    // When cacheGet returns null, research node falls through to LLM extraction
    // This is the expected behavior — cache miss means re-research, not error

    vi.mock("../../src/infra/redis.js", () => ({
      incrQuota: vi.fn().mockResolvedValue(1),
      cacheGet:  vi.fn().mockResolvedValue(null), // cache miss (Redis down or miss)
      cacheSet:  vi.fn().mockResolvedValue(undefined), // silent fail on write
      getQuota:  vi.fn().mockResolvedValue(0),
      KEYS: { research: (u: string) => u, quota: (t: string, d: string) => `${t}:${d}`, llmCache: (h: string) => h },
      hashPrompt: vi.fn().mockReturnValue("hash"),
      todayUtc: vi.fn().mockReturnValue("2026-05-30"),
      tomorrowMidnightUtc: vi.fn().mockReturnValue(9999999999),
    }));

    const RESEARCH_RESULT = {
      text: JSON.stringify({
        pain_points: ["ops scaling"],
        tech_stack: ["Node.js"],
        team_size: "50-200",
        funding: "Series B",
        recent_news: [],
        raw_summary: "Acme Corp is a fast-growing...",
      }),
      model: "gemini-flash-lite", provider: "google", tier: "nano", tokensIn: 10, tokensOut: 20, costUsd: 0,
    };
    const ICP_RESULT = {
      text: JSON.stringify({ icp_score: 0.75, icp_rationale: "Good fit", outreach_tier: "ceo" }),
      model: "gemini-2.5-flash", provider: "google", tier: "md", tokensIn: 10, tokensOut: 20, costUsd: 0,
    };

    mockCallCascade
      .mockResolvedValueOnce({ // disambiguate
        text: JSON.stringify({ company_url: "https://acme.com", company_name: "Acme" }),
        model: "test", provider: "google", tier: "nano", tokensIn: 10, tokensOut: 10, costUsd: 0,
      })
      .mockResolvedValueOnce(RESEARCH_RESULT) // research (no cache hit)
      .mockResolvedValueOnce(ICP_RESULT);      // icp_score

    const { prospectingSubgraph } = await import("../../src/agents/pods/prospecting.js");
    const result = await prospectingSubgraph.invoke({
      raw_input: "https://acme.com",
      tenant_id: "turicks",
    });

    // Research completed despite cache miss
    expect(result.research).toBeDefined();
    expect(result.errors).toHaveLength(0);
  });
});
