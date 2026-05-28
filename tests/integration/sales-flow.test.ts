/**
 * Integration tests for the Sales Pod flow
 * Tests: lead_intel → bdr → critic → hitl → finalize
 *
 * Strategy:
 *  - Mock callCascade (no real LLM calls)
 *  - Mock DB queries (no real Postgres)
 *  - Mock requestHITL (no real Telegram)
 *  - Run salesSubgraph.invoke() end-to-end
 *  - Assert on output state
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks — must be hoisted before any imports that trigger the module graph ──

vi.mock("../../src/infra/llm.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/infra/llm.js")>();
  return {
    callCascade: vi.fn(),
    checkBudget: vi.fn().mockResolvedValue(undefined),
    safeParseJson: actual.safeParseJson,
  };
});

vi.mock("../../src/db/queries.js", () => ({
  hasBeenAudited: vi.fn().mockResolvedValue(false),
  writeAuditEntry: vi.fn().mockResolvedValue(undefined),
  createInterrupt: vi.fn().mockResolvedValue("test-interrupt-id-123"),
  resolveInterrupt: vi.fn().mockResolvedValue(true),
  logCost: vi.fn().mockResolvedValue(undefined),
  isSuppressed: vi.fn().mockResolvedValue(false),
  // Phase 3B: self-improvement loop (non-blocking, return empty arrays/void)
  writeTaskOutcome: vi.fn().mockResolvedValue(undefined),
  getRecentOutcomes: vi.fn().mockResolvedValue([]),
  // Phase 3C: cross-dept signals (non-blocking fire-and-forget)
  publishDeptEvent: vi.fn().mockResolvedValue("mock-event-id"),
}));

vi.mock("../../src/infra/redis.js", () => ({
  incrQuota: vi.fn().mockResolvedValue(1),
  getRedis: vi.fn(),
  closeRedis: vi.fn().mockResolvedValue(undefined),
  KEYS: { research: vi.fn(), quota: vi.fn(), llmCache: vi.fn() },
}));

vi.mock("../../src/gateway/hitl.js", () => ({
  requestHITL: vi.fn().mockResolvedValue({
    status: "pending",
    interrupt_id: "test-interrupt-id-123",
    requested_at: new Date().toISOString(),
  }),
}));

// ── Actual imports (after mocks are registered) ───────────────────────────────

import { callCascade, checkBudget, safeParseJson } from "../../src/infra/llm.js";
import { hasBeenAudited, writeAuditEntry } from "../../src/db/queries.js";
import { requestHITL } from "../../src/gateway/hitl.js";
import { salesSubgraph } from "../../src/agents/pods/sales.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const mockCallCascade = vi.mocked(callCascade);
const mockCheckBudget = vi.mocked(checkBudget);
const mockHasBeenAudited = vi.mocked(hasBeenAudited);
const mockWriteAuditEntry = vi.mocked(writeAuditEntry);
const mockRequestHITL = vi.mocked(requestHITL);

/** Build a minimal initial SalesState for the subgraph. */
function makeInitialState(overrides: Record<string, unknown> = {}) {
  return {
    tenant_id: "turicks",
    trace_id: "test-trace-001",
    task: "Write outreach email to Acme Corp CEO John Smith who is struggling with manual data entry.",
    max_revisions: 2,
    ...overrides,
  };
}

/** Fake callCascade response that mimics the real return shape. */
function mockCascadeResponse(text: string, model = "gemini-1.5-flash") {
  return { text, model, usage: { promptTokens: 50, completionTokens: 50 } };
}

// ── LLM response fixtures ─────────────────────────────────────────────────────

const LEAD_INTEL_RESPONSE = JSON.stringify({
  lead: {
    name: "John Smith",
    company: "Acme Corp",
    url: "https://acme.example.com",
    pain_points: ["manual data entry", "no automation", "wasted hours"],
    icp_score: 0.85,
    budget_signal: "medium",
    linkedin_url: "https://linkedin.com/in/johnsmith",
    source: "cold_email",
  },
  intel_report: "Acme Corp is a 50-person manufacturing firm struggling with manual processes. John Smith, CEO, posted about Excel chaos last week. Strong ICP fit.",
});

const BDR_EMAIL_RESPONSE = JSON.stringify({
  subject: "Your Excel chaos — a 3-day fix",
  body: "John,\n\nSpotted your post about the data entry bottleneck. We built an AI automation for a similar ops team in 3 days — saved them 12 hours/week.\n\nWould 20 minutes this week make sense?\n\nPushkar",
});

const CRITIC_APPROVED_RESPONSE = JSON.stringify({
  result: "APPROVED",
  notes: "Clean pain-first opening. Under 150 words. Single CTA. No banned phrases.",
  rule_violations: [],
});

const CRITIC_NEEDS_REVISION_RESPONSE = JSON.stringify({
  result: "NEEDS_REVISION",
  notes: "Contains banned phrase 'excited to share'. Word count OK.",
  rule_violations: ["banned_phrase"],
});

const BDR_EMAIL_REVISED_RESPONSE = JSON.stringify({
  subject: "3-day automation fix for your data entry problem",
  body: "John,\n\nYour post about the data entry bottleneck caught my attention — we solved the same problem for a manufacturing team in 3 days.\n\nWould 20 minutes this week work?\n\nPushkar",
});

const SALES_ENGINEER_RESPONSE = JSON.stringify({
  angle: "ops_cost",
  hook: "Your post about Excel chaos caught my attention",
  value_prop: "We build AI automation that eliminates manual data entry in 3–5 days",
  proof_point: "12 hours/week saved for a similar manufacturing ops team",
  cta: "20-minute call this week?",
  tier_rationale: "Strong ICP fit at 0.85 — CEO tier engagement appropriate",
});

// ── Test suite ────────────────────────────────────────────────────────────────

describe("Sales Pod — happy path (APPROVED on first critique)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckBudget.mockResolvedValue(undefined);
    mockHasBeenAudited.mockResolvedValue(false);
    mockWriteAuditEntry.mockResolvedValue(undefined);
    mockRequestHITL.mockResolvedValue({
      status: "pending",
      interrupt_id: "test-interrupt-id-123",
      requested_at: new Date().toISOString(),
    });
  });

  it("flows lead_intel → bdr → critic(APPROVED) → hitl → finalize", async () => {
    // Four callCascade calls: lead_intel, sales_engineer, bdr, critic
    mockCallCascade
      .mockResolvedValueOnce(mockCascadeResponse(LEAD_INTEL_RESPONSE, "gemini-2.5-pro"))
      .mockResolvedValueOnce(mockCascadeResponse(SALES_ENGINEER_RESPONSE, "gemini-1.5-flash"))
      .mockResolvedValueOnce(mockCascadeResponse(BDR_EMAIL_RESPONSE, "gemini-1.5-flash"))
      .mockResolvedValueOnce(mockCascadeResponse(CRITIC_APPROVED_RESPONSE, "claude-haiku-4-5"));

    const result = await salesSubgraph.invoke(makeInitialState());

    // Lead was researched
    expect(result.lead).not.toBeNull();
    expect(result.lead?.company).toBe("Acme Corp");
    expect(result.lead?.icp_score).toBe(0.85);

    // Email was drafted
    expect(result.email_draft).not.toBeNull();
    expect(result.email_draft?.subject).toBe("Your Excel chaos — a 3-day fix");

    // Critique was recorded
    expect(result.critiques).toHaveLength(1);
    expect(result.critiques[0]?.result).toBe("APPROVED");
    expect(result.critiques[0]?.rule_violations).toHaveLength(0);

    // Revision count incremented once (by criticNode)
    expect(result.revision_count).toBe(1);

    // HITL was requested
    expect(mockRequestHITL).toHaveBeenCalledTimes(1);
    expect(mockRequestHITL).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "bdr",
        tenant_id: "turicks",
      }),
    );

    // Final state set
    expect(result.final).not.toBeNull();
    expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
  });

  it("callCascade is called exactly 4 times (lead_intel + sales_engineer + bdr + critic)", async () => {
    mockCallCascade
      .mockResolvedValueOnce(mockCascadeResponse(LEAD_INTEL_RESPONSE))
      .mockResolvedValueOnce(mockCascadeResponse(SALES_ENGINEER_RESPONSE))
      .mockResolvedValueOnce(mockCascadeResponse(BDR_EMAIL_RESPONSE))
      .mockResolvedValueOnce(mockCascadeResponse(CRITIC_APPROVED_RESPONSE));

    await salesSubgraph.invoke(makeInitialState());

    expect(mockCallCascade).toHaveBeenCalledTimes(4);

    // First call: lead_intel agent on deep_research tier
    expect(mockCallCascade.mock.calls[0]?.[0]).toBe("deep_research");
    expect(mockCallCascade.mock.calls[0]?.[2]).toMatchObject({ agent: "lead_intel" });

    // Second call: sales_engineer agent on md tier
    expect(mockCallCascade.mock.calls[1]?.[0]).toBe("md");
    expect(mockCallCascade.mock.calls[1]?.[2]).toMatchObject({ agent: "sales_engineer" });

    // Third call: bdr agent on md tier
    expect(mockCallCascade.mock.calls[2]?.[0]).toBe("md");
    expect(mockCallCascade.mock.calls[2]?.[2]).toMatchObject({ agent: "bdr" });

    // Fourth call: critic agent
    expect(mockCallCascade.mock.calls[3]?.[0]).toBe("critic");
    expect(mockCallCascade.mock.calls[3]?.[2]).toMatchObject({ agent: "critic" });
  });

  it("critic uses a different model family (claude) than generators", async () => {
    mockCallCascade
      .mockResolvedValueOnce(mockCascadeResponse(LEAD_INTEL_RESPONSE, "gemini-2.5-pro"))
      .mockResolvedValueOnce(mockCascadeResponse(SALES_ENGINEER_RESPONSE, "gemini-1.5-flash"))
      .mockResolvedValueOnce(mockCascadeResponse(BDR_EMAIL_RESPONSE, "gemini-1.5-flash"))
      .mockResolvedValueOnce(mockCascadeResponse(CRITIC_APPROVED_RESPONSE, "claude-haiku-4-5"));

    const result = await salesSubgraph.invoke(makeInitialState());

    // Critic record stores the model used
    expect(result.critiques[0]?.critic_model).toBe("claude-haiku-4-5");
  });
});

describe("Sales Pod — revision loop (NEEDS_REVISION then APPROVED)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckBudget.mockResolvedValue(undefined);
    mockHasBeenAudited.mockResolvedValue(false);
    mockWriteAuditEntry.mockResolvedValue(undefined);
    mockRequestHITL.mockResolvedValue({
      status: "pending",
      interrupt_id: "test-interrupt-id-456",
      requested_at: new Date().toISOString(),
    });
  });

  it("retries bdr when first critique is NEEDS_REVISION, approves on second", async () => {
    // 6 callCascade calls: lead_intel, sales_engineer, bdr1, critic1(reject), bdr2, critic2(approve)
    mockCallCascade
      .mockResolvedValueOnce(mockCascadeResponse(LEAD_INTEL_RESPONSE))            // lead_intel
      .mockResolvedValueOnce(mockCascadeResponse(SALES_ENGINEER_RESPONSE))        // sales_engineer
      .mockResolvedValueOnce(mockCascadeResponse(BDR_EMAIL_RESPONSE))             // bdr draft 1
      .mockResolvedValueOnce(mockCascadeResponse(CRITIC_NEEDS_REVISION_RESPONSE)) // critic 1: reject
      .mockResolvedValueOnce(mockCascadeResponse(BDR_EMAIL_REVISED_RESPONSE))     // bdr draft 2
      .mockResolvedValueOnce(mockCascadeResponse(CRITIC_APPROVED_RESPONSE));      // critic 2: approve

    const result = await salesSubgraph.invoke(makeInitialState());

    // Both critiques recorded
    expect(result.critiques).toHaveLength(2);
    expect(result.critiques[0]?.result).toBe("NEEDS_REVISION");
    expect(result.critiques[1]?.result).toBe("APPROVED");

    // revision_count incremented twice
    expect(result.revision_count).toBe(2);

    // Final email is the revised version
    expect(result.email_draft?.subject).toBe("3-day automation fix for your data entry problem");

    // HITL called once (after final APPROVED)
    expect(mockRequestHITL).toHaveBeenCalledTimes(1);

    // callCascade: 1 (lead) + 1 (sales_engineer) + 2 (bdr) + 2 (critic) = 6
    expect(mockCallCascade).toHaveBeenCalledTimes(6);
  });

  it("bdr revision includes critique feedback in its prompt", async () => {
    mockCallCascade
      .mockResolvedValueOnce(mockCascadeResponse(LEAD_INTEL_RESPONSE))
      .mockResolvedValueOnce(mockCascadeResponse(SALES_ENGINEER_RESPONSE))
      .mockResolvedValueOnce(mockCascadeResponse(BDR_EMAIL_RESPONSE))
      .mockResolvedValueOnce(mockCascadeResponse(CRITIC_NEEDS_REVISION_RESPONSE))
      .mockResolvedValueOnce(mockCascadeResponse(BDR_EMAIL_REVISED_RESPONSE))
      .mockResolvedValueOnce(mockCascadeResponse(CRITIC_APPROVED_RESPONSE));

    await salesSubgraph.invoke(makeInitialState());

    // The 5th call (index 4) is bdr's second attempt — its user message should include critique feedback
    const bdrRevisionMessages = mockCallCascade.mock.calls[4]?.[1];
    expect(bdrRevisionMessages).toBeDefined();

    // LangChain BaseMessage uses getType() === "human", not .role === "user"
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userMsg = bdrRevisionMessages?.find((m: any) =>
      typeof m.getType === "function" ? m.getType() === "human" : m.role === "user",
    );
    // Content may be string | MessageContentComplex[] — normalise to string
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawContent = (userMsg as any)?.content;
    const contentStr = Array.isArray(rawContent)
      ? rawContent.map((c: unknown) => (typeof c === "string" ? c : JSON.stringify(c))).join("")
      : String(rawContent ?? "");
    expect(contentStr).toContain("PREVIOUS CRITIQUE FEEDBACK");
    expect(contentStr).toContain("banned_phrase");
  });
});

describe("Sales Pod — escalation path (max revisions reached)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckBudget.mockResolvedValue(undefined);
    mockHasBeenAudited.mockResolvedValue(false);
    mockWriteAuditEntry.mockResolvedValue(undefined);
    mockRequestHITL.mockResolvedValue({
      status: "pending",
      interrupt_id: "escalated-interrupt-id",
      requested_at: new Date().toISOString(),
    });
  });

  it("escalates to hitl when max_revisions=1 and critic fails", async () => {
    // max_revisions=1: bdr → critic(reject, count=1 = max) → hitl (escalated)
    mockCallCascade
      .mockResolvedValueOnce(mockCascadeResponse(LEAD_INTEL_RESPONSE))
      .mockResolvedValueOnce(mockCascadeResponse(SALES_ENGINEER_RESPONSE))
      .mockResolvedValueOnce(mockCascadeResponse(BDR_EMAIL_RESPONSE))
      .mockResolvedValueOnce(mockCascadeResponse(CRITIC_NEEDS_REVISION_RESPONSE));

    const result = await salesSubgraph.invoke(makeInitialState({ max_revisions: 1 }));

    // Only one critique (escalated after it)
    expect(result.critiques).toHaveLength(1);
    expect(result.critiques[0]?.result).toBe("NEEDS_REVISION");

    // revision_count = max_revisions = 1
    expect(result.revision_count).toBe(1);

    // HITL was still called (escalation path)
    expect(mockRequestHITL).toHaveBeenCalledTimes(1);

    // callCascade: 1 (lead) + 1 (sales_engineer) + 1 (bdr) + 1 (critic) = 4
    expect(mockCallCascade).toHaveBeenCalledTimes(4);
  });

  it("escalates with a note in HITL summary when revision limit hit", async () => {
    mockCallCascade
      .mockResolvedValueOnce(mockCascadeResponse(LEAD_INTEL_RESPONSE))
      .mockResolvedValueOnce(mockCascadeResponse(SALES_ENGINEER_RESPONSE))
      .mockResolvedValueOnce(mockCascadeResponse(BDR_EMAIL_RESPONSE))
      .mockResolvedValueOnce(mockCascadeResponse(CRITIC_NEEDS_REVISION_RESPONSE));

    await salesSubgraph.invoke(makeInitialState({ max_revisions: 1 }));

    const hitlCall = mockRequestHITL.mock.calls[0]?.[0];
    expect(hitlCall?.summary).toContain("Escalated");
    expect(hitlCall?.summary).toContain("revision");
  });
});

describe("Sales Pod — idempotency guard", () => {
  it("skips writeAuditEntry when already audited (idempotent finalize)", async () => {
    vi.clearAllMocks();
    mockCheckBudget.mockResolvedValue(undefined);
    mockHasBeenAudited.mockResolvedValue(true); // Already finalized
    mockWriteAuditEntry.mockResolvedValue(undefined);
    mockRequestHITL.mockResolvedValue({
      status: "pending",
      interrupt_id: "dup-interrupt-id",
      requested_at: new Date().toISOString(),
    });

    mockCallCascade
      .mockResolvedValueOnce(mockCascadeResponse(LEAD_INTEL_RESPONSE))
      .mockResolvedValueOnce(mockCascadeResponse(SALES_ENGINEER_RESPONSE))
      .mockResolvedValueOnce(mockCascadeResponse(BDR_EMAIL_RESPONSE))
      .mockResolvedValueOnce(mockCascadeResponse(CRITIC_APPROVED_RESPONSE));

    await salesSubgraph.invoke(makeInitialState());

    // writeAuditEntry was NOT called because hasBeenAudited returned true
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
  });
});

describe("Sales Pod — graceful degradation on LLM parse failure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckBudget.mockResolvedValue(undefined);
    mockHasBeenAudited.mockResolvedValue(false);
    mockWriteAuditEntry.mockResolvedValue(undefined);
    mockRequestHITL.mockResolvedValue({
      status: "pending",
      interrupt_id: "fallback-interrupt-id",
      requested_at: new Date().toISOString(),
    });
  });

  it("handles lead_intel JSON parse failure gracefully (uses fallback lead)", async () => {
    mockCallCascade
      .mockResolvedValueOnce(mockCascadeResponse("Not JSON at all — raw text report"))
      .mockResolvedValueOnce(mockCascadeResponse(SALES_ENGINEER_RESPONSE))
      .mockResolvedValueOnce(mockCascadeResponse(BDR_EMAIL_RESPONSE))
      .mockResolvedValueOnce(mockCascadeResponse(CRITIC_APPROVED_RESPONSE));

    const result = await salesSubgraph.invoke(makeInitialState());

    // Uses fallback lead values
    expect(result.lead?.name).toBe("Unknown");
    expect(result.lead?.company).toBe("Unknown");
    expect(result.lead?.icp_score).toBe(0.5);

    // Rest of pipeline continues normally
    expect(result.email_draft).not.toBeNull();
    expect(result.critiques[0]?.result).toBe("APPROVED");
  });

  it("handles bdr JSON parse failure gracefully (wraps raw text)", async () => {
    mockCallCascade
      .mockResolvedValueOnce(mockCascadeResponse(LEAD_INTEL_RESPONSE))
      .mockResolvedValueOnce(mockCascadeResponse(SALES_ENGINEER_RESPONSE))
      .mockResolvedValueOnce(mockCascadeResponse("Here is your email: blah blah blah"))
      .mockResolvedValueOnce(mockCascadeResponse(CRITIC_APPROVED_RESPONSE));

    const result = await salesSubgraph.invoke(makeInitialState());

    // Uses fallback email_draft values
    expect(result.email_draft?.subject).toBe("Following up on your project");
    expect(result.email_draft?.body).toContain("blah blah blah");
  });

  it("handles critic JSON parse failure as APPROVED-with-warning (flows to HITL)", async () => {
    // Critic parse failure → APPROVED with critic_parse_error violation → flows straight to HITL
    // Design intent: parse failure must never cause infinite revision loops
    mockCallCascade
      .mockResolvedValueOnce(mockCascadeResponse(LEAD_INTEL_RESPONSE))
      .mockResolvedValueOnce(mockCascadeResponse(SALES_ENGINEER_RESPONSE))
      .mockResolvedValueOnce(mockCascadeResponse(BDR_EMAIL_RESPONSE))
      .mockResolvedValueOnce(mockCascadeResponse("I cannot evaluate this properly")); // bad critic JSON

    const result = await salesSubgraph.invoke(makeInitialState({ max_revisions: 1 }));

    // Critique created as APPROVED (not NEEDS_REVISION) to prevent infinite loops
    expect(result.critiques[0]?.result).toBe("APPROVED");
    expect(result.critiques[0]?.rule_violations).toContain("critic_parse_error");

    // Flows to HITL for human review (doesn't crash)
    expect(mockRequestHITL).toHaveBeenCalledTimes(1);
  });
});
