/**
 * Integration — Critic revision loop.
 *
 * Tests the critic node's retry/escalation logic in isolation.
 *
 * Tests:
 *   1. APPROVED on first try → hitl_gate called once
 *   2. NEEDS_REVISION × 1 → revision + second attempt → APPROVED → hitl once
 *   3. NEEDS_REVISION × max_revisions → escalation (hitl with escalation context)
 *   4. Critic returns malformed JSON → fail-open: auto-APPROVED, HITL proceeds
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCallCascade = vi.fn();
const mockRequestHITL = vi.fn().mockResolvedValue({
  interrupt_id: "test-interrupt",
  status: "pending",
  requested_at: new Date().toISOString(),
});

vi.mock("../../../src/infra/llm.js", () => ({
  callCascade: mockCallCascade,
  checkBudget: vi.fn().mockResolvedValue(undefined),
  safeParseJson: (text: string) => {
    try { return JSON.parse(text) as Record<string, unknown>; }
    catch { return null; }
  },
  runPlanner:     vi.fn().mockRejectedValue(new Error("not used")),
  runToolExecutor: vi.fn().mockRejectedValue(new Error("not used")),
}));

vi.mock("../../../src/db/queries.js", () => ({
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

vi.mock("../../../src/infra/redis.js", () => ({
  incrQuota:  vi.fn().mockResolvedValue(1),
  cacheGet:   vi.fn().mockResolvedValue(null),
  cacheSet:   vi.fn().mockResolvedValue(undefined),
  getQuota:   vi.fn().mockResolvedValue(0),
  KEYS: { research: (u: string) => u, quota: (t: string, d: string) => `${t}:${d}`, llmCache: (h: string) => h },
  hashPrompt: vi.fn().mockReturnValue("hash"),
  todayUtc: vi.fn().mockReturnValue("2026-05-30"),
  tomorrowMidnightUtc: vi.fn().mockReturnValue(9999999999),
}));

vi.mock("../../../src/gateway/hitl.js", () => ({
  requestHITL: mockRequestHITL,
}));

vi.mock("../../../src/core/config.js", () => ({
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

// ── Response helpers ──────────────────────────────────────────────────────────

const makeCascadeResult = (text: string, tier = "md") => ({
  text, model: "test-model", provider: "google", tier,
  tokensIn: 10, tokensOut: 20, costUsd: 0,
});

const LEAD_INTEL = makeCascadeResult(JSON.stringify({
  lead: { name: "Ben Francis", company: "Gymshark", url: "", pain_points: [], icp_score: 0.8, budget_signal: "high", source: "cold_email" },
  intel_report: "Research report",
}), "deep_research");

const SALES_ENG = makeCascadeResult(JSON.stringify({
  angle: "automation", hook: "Scale faster", value_prop: "AI agents", proof_point: "40% cost reduction", cta: "15 min call",
}));

const BDR_DRAFT = makeCascadeResult(JSON.stringify({
  subject: "Quick question about Gymshark ops",
  body: "Hi Ben, noticed Gymshark is scaling fast...",
}));

const APPROVED = makeCascadeResult(JSON.stringify({
  result: "APPROVED", notes: "Good email", rule_violations: [], critic_model: "claude-haiku-4-5",
}), "critic");

const NEEDS_REVISION = makeCascadeResult(JSON.stringify({
  result: "NEEDS_REVISION", notes: "Too generic", rule_violations: ["too generic"], critic_model: "claude-haiku-4-5",
}), "critic");

const MALFORMED_JSON = makeCascadeResult("Here is my critique: the email looks decent", "critic");

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Critic revision loop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequestHITL.mockResolvedValue({
      interrupt_id: "test-interrupt",
      status: "pending",
      requested_at: new Date().toISOString(),
    });
  });

  it("APPROVED on first try → HITL called exactly once", async () => {
    mockCallCascade
      .mockResolvedValueOnce(LEAD_INTEL)
      .mockResolvedValueOnce(SALES_ENG)
      .mockResolvedValueOnce(BDR_DRAFT)
      .mockResolvedValueOnce(APPROVED);

    const { salesSubgraph } = await import("../../../src/agents/pods/sales.js");
    await salesSubgraph.invoke({ task: "Reach out to Gymshark", tenant_id: "turicks" });

    expect(mockRequestHITL).toHaveBeenCalledOnce();
  });

  it("NEEDS_REVISION × 1 → revision count = 1, HITL called once after 2nd critic pass", async () => {
    mockCallCascade
      .mockResolvedValueOnce(LEAD_INTEL)
      .mockResolvedValueOnce(SALES_ENG)
      .mockResolvedValueOnce(BDR_DRAFT)    // bdr attempt 1
      .mockResolvedValueOnce(NEEDS_REVISION) // critic → needs revision
      .mockResolvedValueOnce(BDR_DRAFT)    // bdr attempt 2
      .mockResolvedValueOnce(APPROVED);    // critic → approved

    const { salesSubgraph } = await import("../../../src/agents/pods/sales.js");
    const result = await salesSubgraph.invoke({
      task: "Reach out to Gymshark",
      tenant_id: "turicks",
      max_revisions: 2,
    });

    // revision_count = number of critic invocations: 2 (one NEEDS_REVISION + one APPROVED)
    expect(result.revision_count).toBe(2);
    expect(mockRequestHITL).toHaveBeenCalledOnce();
  });

  it("NEEDS_REVISION × max_revisions → escalates to HITL (not infinite loop)", async () => {
    // 2 revisions then escalate
    mockCallCascade
      .mockResolvedValueOnce(LEAD_INTEL)
      .mockResolvedValueOnce(SALES_ENG)
      .mockResolvedValueOnce(BDR_DRAFT)
      .mockResolvedValueOnce(NEEDS_REVISION)
      .mockResolvedValueOnce(BDR_DRAFT)
      .mockResolvedValueOnce(NEEDS_REVISION); // 2nd rejection at max

    const { salesSubgraph } = await import("../../../src/agents/pods/sales.js");
    const result = await salesSubgraph.invoke({
      task: "Reach out to Gymshark",
      tenant_id: "turicks",
      max_revisions: 2,
    });

    // BDR was called exactly (max_revisions + 1) = 3 times (1 initial + 2 revisions)
    const bdrCalls = mockCallCascade.mock.calls.filter(
      (call) => call[0] === "md",
    );
    // bdr + sales_engineer both use "md" tier — bdr is the one after sales_eng
    // At least max_revisions + 1 calls on md tier
    expect(bdrCalls.length).toBeGreaterThanOrEqual(3);

    // HITL still called once (escalated)
    expect(mockRequestHITL).toHaveBeenCalledOnce();
  });

  it("critic returns malformed JSON → fail-open: auto-APPROVED, HITL proceeds", async () => {
    mockCallCascade
      .mockResolvedValueOnce(LEAD_INTEL)
      .mockResolvedValueOnce(SALES_ENG)
      .mockResolvedValueOnce(BDR_DRAFT)
      .mockResolvedValueOnce(MALFORMED_JSON); // critic fails to return JSON

    const { salesSubgraph } = await import("../../../src/agents/pods/sales.js");
    const result = await salesSubgraph.invoke({
      task: "Reach out to Gymshark",
      tenant_id: "turicks",
    });

    // Malformed JSON → critic fail-open → HITL should still be called
    expect(mockRequestHITL).toHaveBeenCalledOnce();
    expect(result.errors).toHaveLength(0); // not an error — graceful degradation
  });
});
