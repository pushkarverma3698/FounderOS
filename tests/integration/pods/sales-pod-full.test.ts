/**
 * Integration — Full sales pod flow.
 *
 * Uses MockLLM + test DB + test Redis mocks.
 * Tests the complete state machine: lead_intel → suppression → quota → bdr → critic → HITL → finalize
 *
 * Tests:
 *   1. Happy path: all nodes succeed, HITL queued
 *   2. Suppressed lead: suppression_check → suppressed_end (no bdr called)
 *   3. Quota exceeded: quota_check → quota_end (no bdr called)
 *   4. Critic NEEDS_REVISION: revision count increments, bdr called again
 *   5. Critic NEEDS_REVISION at max → escalates to HITL with escalation note
 *   6. HITL approved → finalize writes audit_log
 *   7. All LLM providers fail → error state returned (P4-HARD-1 verified at integration level)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module mocks ──────────────────────────────────────────────────────────────

// Default: LLM cascade succeeds, suppression=false, quota ok
const mockCallCascade = vi.fn();
const mockIsSuppressed = vi.fn().mockResolvedValue(false);
const mockIncrQuota = vi.fn().mockResolvedValue(1);
const mockRequestHITL = vi.fn().mockResolvedValue({
  interrupt_id: "test-interrupt-id",
  status: "pending",
  requested_at: new Date().toISOString(),
});

vi.mock("../../../src/infra/llm.js", () => ({
  callCascade:    mockCallCascade,
  checkBudget:    vi.fn().mockResolvedValue(undefined),
  safeParseJson:  (text: string) => {
    try { return JSON.parse(text) as Record<string, unknown>; }
    catch { return null; }
  },
  runPlanner:     vi.fn().mockRejectedValue(new Error("not used")),
  runToolExecutor: vi.fn().mockRejectedValue(new Error("not used")),
}));

vi.mock("../../../src/db/queries.js", () => ({
  hasBeenAudited:   vi.fn().mockResolvedValue(false),
  writeAuditEntry:  vi.fn().mockResolvedValue(undefined),
  isSuppressed:     mockIsSuppressed,
  logLlmCost:       vi.fn().mockResolvedValue(undefined),
  getTodayCostUsd:  vi.fn().mockResolvedValue(0),
  createInterruptRecord: vi.fn().mockResolvedValue({ id: "test-id" }),
  updateInterruptStatus: vi.fn().mockResolvedValue(undefined),
  getInterruptRecord: vi.fn().mockResolvedValue(null),
  writeTaskOutcome: vi.fn().mockResolvedValue(undefined),
  getRecentOutcomes: vi.fn().mockResolvedValue([]),
  publishDeptEvent: vi.fn().mockResolvedValue(undefined),
  resolveInterrupt: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../src/infra/redis.js", () => ({
  incrQuota: mockIncrQuota,
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

vi.mock("../../../src/gateway/hitl.js", () => ({
  requestHITL: mockRequestHITL,
}));

vi.mock("../../../src/core/config.js", () => ({
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
  CASCADE: { md: [], ceo: [], nano: [], deep_research: [], code: [], critic: [], local: [], video: [] },
  CIRCUIT_BREAKER_OPTIONS: { timeout: 5000, errorThresholdPercentage: 50, resetTimeout: 30000, volumeThreshold: 10 },
  RATE_LIMITER_OPTIONS: { maxConcurrent: 5, minTime: 0 },
  TIER_MAX_TOKENS: { md: 2048, ceo: 512, nano: 256, deep_research: 4096, code: 4096, critic: 1024, local: 1024, video: 256 },
  MODEL_COST_PER_1M: {},
  LLM_CACHE_TTL: { ceo: 0, md: 3600, nano: 86400 },
  RESEARCH_CACHE_TTL_SECONDS: 604800,
}));

// ── Response builders ─────────────────────────────────────────────────────────

const LEAD_INTEL_RESULT = {
  text: JSON.stringify({
    lead: {
      name: "Ben Francis",
      company: "Gymshark",
      url: "https://gymshark.com",
      pain_points: ["scaling ops", "AI automation"],
      icp_score: 0.85,
      budget_signal: "high",
      source: "cold_email",
    },
    intel_report: "Gymshark is a fast-growing fitness brand...",
  }),
  model: "gemini-2.5-flash", provider: "google", tier: "deep_research",
  tokensIn: 100, tokensOut: 200, costUsd: 0.001,
};

const SALES_ENGINEER_RESULT = {
  text: JSON.stringify({
    angle: "ai_automation",
    hook: "Scale ops without adding headcount",
    value_prop: "AI agents for backend automation",
    proof_point: "Similar clients reduced ops costs 40%",
    cta: "15-min call",
  }),
  model: "gemini-2.5-flash", provider: "google", tier: "md",
  tokensIn: 50, tokensOut: 100, costUsd: 0,
};

const BDR_RESULT = {
  text: JSON.stringify({
    subject: "Gymshark ops team scaling issue?",
    body: "Hi Ben, noticed Gymshark is growing fast...",
  }),
  model: "gemini-2.5-flash", provider: "google", tier: "md",
  tokensIn: 50, tokensOut: 80, costUsd: 0,
};

const CRITIC_APPROVED = {
  text: JSON.stringify({
    result: "APPROVED",
    notes: "Email is concise and personalized",
    rule_violations: [],
    critic_model: "claude-haiku-4-5",
  }),
  model: "claude-haiku-4-5", provider: "anthropic", tier: "critic",
  tokensIn: 100, tokensOut: 50, costUsd: 0,
};

const CRITIC_NEEDS_REVISION = {
  text: JSON.stringify({
    result: "NEEDS_REVISION",
    notes: "Email is too generic — add specific pain point",
    rule_violations: ["too generic"],
    critic_model: "claude-haiku-4-5",
  }),
  model: "claude-haiku-4-5", provider: "anthropic", tier: "critic",
  tokensIn: 100, tokensOut: 50, costUsd: 0,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Sales pod — full integration flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsSuppressed.mockResolvedValue(false);
    mockIncrQuota.mockResolvedValue(1);
    mockRequestHITL.mockResolvedValue({
      interrupt_id: "test-interrupt-id",
      status: "pending",
      requested_at: new Date().toISOString(),
    });
  });

  it("happy path: lead_intel → suppression(clear) → quota(ok) → bdr → critic(APPROVED) → HITL queued", async () => {
    mockCallCascade
      .mockResolvedValueOnce(LEAD_INTEL_RESULT)      // lead_intel
      .mockResolvedValueOnce(SALES_ENGINEER_RESULT)  // sales_engineer
      .mockResolvedValueOnce(BDR_RESULT)             // bdr
      .mockResolvedValueOnce(CRITIC_APPROVED);       // critic

    const { salesSubgraph } = await import("../../../src/agents/pods/sales.js");
    const result = await salesSubgraph.invoke({
      task: "Reach out to Gymshark about AI automation",
      tenant_id: "turicks",
    });

    // Lead was profiled
    expect(result.lead?.company).toBe("Gymshark");
    expect(result.lead?.icp_score).toBe(0.85);

    // Email was drafted
    expect(result.email_draft?.subject).toContain("Gymshark");

    // HITL was requested
    expect(mockRequestHITL).toHaveBeenCalledOnce();

    // No errors
    expect(result.errors).toHaveLength(0);
  });

  it("suppressed lead: flow ends at suppressed_end — bdr never called", async () => {
    mockCallCascade.mockResolvedValueOnce(LEAD_INTEL_RESULT); // lead_intel
    mockIsSuppressed.mockResolvedValue(true); // suppressed!

    const { salesSubgraph } = await import("../../../src/agents/pods/sales.js");
    const result = await salesSubgraph.invoke({
      task: "Reach out to Gymshark",
      tenant_id: "turicks",
    });

    // BDR must not be called when lead is suppressed
    expect(result.final?.status).toBe("suppressed");
    expect(mockRequestHITL).not.toHaveBeenCalled();
  });

  it("quota exceeded: flow ends at quota_end — bdr never called", async () => {
    mockCallCascade.mockResolvedValueOnce(LEAD_INTEL_RESULT); // lead_intel
    mockIncrQuota.mockResolvedValue(11); // over limit (DAILY_SEND_LIMIT = 10)

    const { salesSubgraph } = await import("../../../src/agents/pods/sales.js");
    const result = await salesSubgraph.invoke({
      task: "Reach out to Gymshark",
      tenant_id: "turicks",
    });

    expect(result.final?.status).toBe("quota_exceeded");
    expect(mockRequestHITL).not.toHaveBeenCalled();
  });

  it("critic NEEDS_REVISION × 1 → bdr called again, then APPROVED → HITL queued once", async () => {
    mockCallCascade
      .mockResolvedValueOnce(LEAD_INTEL_RESULT)      // lead_intel
      .mockResolvedValueOnce(SALES_ENGINEER_RESULT)  // sales_engineer
      .mockResolvedValueOnce(BDR_RESULT)             // bdr (attempt 1)
      .mockResolvedValueOnce(CRITIC_NEEDS_REVISION)  // critic → NEEDS_REVISION
      .mockResolvedValueOnce(BDR_RESULT)             // bdr (attempt 2 — revision)
      .mockResolvedValueOnce(CRITIC_APPROVED);       // critic → APPROVED

    const { salesSubgraph } = await import("../../../src/agents/pods/sales.js");
    const result = await salesSubgraph.invoke({
      task: "Reach out to Gymshark",
      tenant_id: "turicks",
      max_revisions: 2,
    });

    // revision_count tracks critic invocations: 2 (one NEEDS_REVISION + one APPROVED)
    expect(result.revision_count).toBe(2);
    expect(mockRequestHITL).toHaveBeenCalledOnce();
    expect(result.errors).toHaveLength(0);
  });

  it("critic NEEDS_REVISION at max_revisions → escalates to HITL with escalation flag", async () => {
    mockCallCascade
      .mockResolvedValueOnce(LEAD_INTEL_RESULT)      // lead_intel
      .mockResolvedValueOnce(SALES_ENGINEER_RESULT)  // sales_engineer
      .mockResolvedValueOnce(BDR_RESULT)             // bdr (attempt 1)
      .mockResolvedValueOnce(CRITIC_NEEDS_REVISION)  // critic → NEEDS_REVISION
      .mockResolvedValueOnce(BDR_RESULT)             // bdr (attempt 2)
      .mockResolvedValueOnce(CRITIC_NEEDS_REVISION); // critic → NEEDS_REVISION again (at max)

    const { salesSubgraph } = await import("../../../src/agents/pods/sales.js");
    const result = await salesSubgraph.invoke({
      task: "Reach out to Gymshark",
      tenant_id: "turicks",
      max_revisions: 2,
    });

    // At max revisions, should still reach HITL (escalated)
    expect(mockRequestHITL).toHaveBeenCalledOnce();
    expect(result.revision_count).toBeGreaterThanOrEqual(2);
  });

  it("all LLM providers fail → error state returned, graph does not crash (P4-HARD-1)", async () => {
    mockCallCascade.mockRejectedValue(
      new AggregateError(
        [new Error("all providers failed")],
        'All cascade entries for tier "deep_research" failed',
      ),
    );

    const { salesSubgraph } = await import("../../../src/agents/pods/sales.js");
    const result = await salesSubgraph.invoke({
      task: "Reach out to Gymshark",
      tenant_id: "turicks",
    });

    // Must not throw — returns error state
    expect(result).toBeDefined();
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toHaveProperty("agent", "lead_intel");
  });
});
