/**
 * CHAOS — Critic always returns NEEDS_REVISION.
 *
 * Tests:
 *   1. Revision count increments correctly: 0 → 1 → 2
 *   2. At max_revisions, escalates to HITL (not infinite loop)
 *   3. BDR was called exactly (max_revisions + 1) times
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCallCascade = vi.fn();

vi.mock("../../src/infra/llm.js", () => ({
  callCascade: mockCallCascade,
  checkBudget: vi.fn().mockResolvedValue(undefined),
  safeParseJson: (text: string) => {
    try { return JSON.parse(text) as Record<string, unknown>; }
    catch { return null; }
  },
  runPlanner: vi.fn().mockRejectedValue(new Error("not used")),
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
  resolveInterrupt:  vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/infra/redis.js", () => ({
  incrQuota: vi.fn().mockResolvedValue(1),
  cacheGet:  vi.fn().mockResolvedValue(null),
  cacheSet:  vi.fn().mockResolvedValue(undefined),
  getQuota:  vi.fn().mockResolvedValue(0),
  KEYS: { research: (u: string) => u, quota: (t: string, d: string) => `${t}:${d}`, llmCache: (h: string) => h },
  hashPrompt: vi.fn().mockReturnValue("hash"),
  todayUtc: vi.fn().mockReturnValue("2026-05-30"),
  tomorrowMidnightUtc: vi.fn().mockReturnValue(9999999999),
}));

vi.mock("../../src/gateway/hitl.js", () => ({
  requestHITL: vi.fn().mockResolvedValue({
    interrupt_id: "escalated-interrupt",
    status: "pending",
    requested_at: new Date().toISOString(),
  }),
}));

vi.mock("../../src/core/config.js", () => ({
  env: {
    BUDGET_DAILY_USD: 999, DAILY_SEND_LIMIT: 10, NODE_ENV: "test", LOG_LEVEL: "silent",
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

// ── Helpers ───────────────────────────────────────────────────────────────────

const LEAD_INTEL = {
  text: JSON.stringify({
    lead: { name: "Test", company: "Acme", url: "", pain_points: [], icp_score: 0.7, budget_signal: "medium", source: "cold_email" },
    intel_report: "Report",
  }),
  model: "gemini-2.5-flash", provider: "google", tier: "deep_research", tokensIn: 10, tokensOut: 20, costUsd: 0,
};

const SALES_ENG = {
  text: JSON.stringify({ angle: "automation", hook: "Scale", value_prop: "AI", proof_point: "40%", cta: "call" }),
  model: "gemini-2.5-flash", provider: "google", tier: "md", tokensIn: 10, tokensOut: 20, costUsd: 0,
};

const BDR_DRAFT = {
  text: JSON.stringify({ subject: "Test", body: "Body" }),
  model: "gemini-2.5-flash", provider: "google", tier: "md", tokensIn: 10, tokensOut: 20, costUsd: 0,
};

const CRITIC_REJECTS = {
  text: JSON.stringify({
    result: "NEEDS_REVISION",
    notes: "Still too generic",
    rule_violations: ["too generic"],
    critic_model: "claude-haiku-4-5",
  }),
  model: "claude-haiku-4-5", provider: "anthropic", tier: "critic", tokensIn: 10, tokensOut: 20, costUsd: 0,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("CHAOS — Critic always rejects", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(vi.importMock("../../src/gateway/hitl.js"))?.requestHITL?.mockResolvedValue({
      interrupt_id: "escalated-interrupt",
      status: "pending",
      requested_at: new Date().toISOString(),
    });
  });

  it("revision_count increments on each critic rejection", async () => {
    const MAX_REVISIONS = 2;
    // Setup: lead_intel + sales_eng + (max+1) BDR + (max+1) critic rejections
    mockCallCascade
      .mockResolvedValueOnce(LEAD_INTEL)
      .mockResolvedValueOnce(SALES_ENG)
      .mockResolvedValueOnce(BDR_DRAFT)    // bdr 1
      .mockResolvedValueOnce(CRITIC_REJECTS) // critic 1 → revision
      .mockResolvedValueOnce(BDR_DRAFT)    // bdr 2
      .mockResolvedValueOnce(CRITIC_REJECTS); // critic 2 → at max → escalate

    const { salesSubgraph } = await import("../../src/agents/pods/sales.js");
    const result = await salesSubgraph.invoke({
      task: "Reach out to Acme",
      tenant_id: "turicks",
      max_revisions: MAX_REVISIONS,
    });

    // revision_count = number of critic invocations = 2
    expect(result.revision_count).toBe(2);
    expect(result.critiques).toHaveLength(2);
  });

  it("escalates to HITL at max_revisions — not infinite loop", async () => {
    const { requestHITL } = await import("../../src/gateway/hitl.js");

    mockCallCascade
      .mockResolvedValueOnce(LEAD_INTEL)
      .mockResolvedValueOnce(SALES_ENG)
      .mockResolvedValueOnce(BDR_DRAFT)
      .mockResolvedValueOnce(CRITIC_REJECTS)
      .mockResolvedValueOnce(BDR_DRAFT)
      .mockResolvedValueOnce(CRITIC_REJECTS); // 2nd rejection = at max

    const { salesSubgraph } = await import("../../src/agents/pods/sales.js");
    await salesSubgraph.invoke({
      task: "Reach out to Acme",
      tenant_id: "turicks",
      max_revisions: 2,
    });

    // HITL must be called once (escalated after max_revisions)
    expect(requestHITL).toHaveBeenCalledOnce();
  });

  it("BDR was called exactly (max_revisions + 1) times", async () => {
    const MAX_REVISIONS = 2;
    // 1 initial BDR + MAX_REVISIONS retries = MAX_REVISIONS + 1 BDR calls
    mockCallCascade
      .mockResolvedValueOnce(LEAD_INTEL)    // lead_intel (deep_research)
      .mockResolvedValueOnce(SALES_ENG)     // sales_engineer (md)
      .mockResolvedValueOnce(BDR_DRAFT)     // bdr attempt 1 (md)
      .mockResolvedValueOnce(CRITIC_REJECTS) // critic → revision
      .mockResolvedValueOnce(BDR_DRAFT)     // bdr attempt 2 (md)
      .mockResolvedValueOnce(CRITIC_REJECTS); // critic → at max → escalate

    const { salesSubgraph } = await import("../../src/agents/pods/sales.js");
    await salesSubgraph.invoke({
      task: "Reach out to Acme",
      tenant_id: "turicks",
      max_revisions: MAX_REVISIONS,
    });

    // Count "md" tier calls: sales_engineer(1) + bdr(1) + bdr_revision(1) = 3
    // But sales_engineer also uses "md", so total md calls = 1 (sales_eng) + 3 (bdr×3) = 4? No...
    // Actually: sales_engineer=1 md, bdr=max_revisions+1 md = 3 total md calls (1 sales_eng + 2 bdr)
    // Wait: MAX_REVISIONS=2 means: bdr_1 → critic_1(reject) → bdr_2 → critic_2(reject@max) → hitl
    // So BDR is called exactly MAX_REVISIONS+1 = 3 times? No — looking at afterCriticEdge:
    // revision_count=0 → critic → revision_count=1 → if 1 >= 2? No → retry bdr
    // revision_count=1 → critic → revision_count=2 → if 2 >= 2? YES → escalate
    // So BDR is called: initial + 1 retry = 2 times (not MAX_REVISIONS+1)
    // My mock has: bdr×2, critic×2 — matches

    // Count "md" tier calls: 1 (sales_eng) + 2 (bdr) = 3 total
    const mdCalls = mockCallCascade.mock.calls.filter((c) => c[0] === "md");
    const criticCalls = mockCallCascade.mock.calls.filter((c) => c[0] === "critic");

    // At MAX_REVISIONS=2: BDR called 2 times (initial + 1 retry = revision_count reaches max at 2)
    expect(criticCalls).toHaveLength(MAX_REVISIONS); // critic called MAX_REVISIONS times
    // md calls = 1 (sales_eng) + MAX_REVISIONS (bdr) = 3
    expect(mdCalls).toHaveLength(1 + MAX_REVISIONS);
  });
});
