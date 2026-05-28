/**
 * TDD — contentWriterNode in marketing pod
 * RED → write failing tests, then implement real LLM call.
 *
 * contentWriterNode must:
 *  - Call callCascade("md", ...) with the brief context in the prompt
 *  - Return a content_draft string from the LLM (not a placeholder/stub)
 *  - Fail-open: if LLM returns empty text, fall back to a descriptive placeholder
 *  - Include platform and format in the draft message when brief is present
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock dependencies ─────────────────────────────────────────────────────────

vi.mock("../../src/infra/llm.js", () => ({
  callCascade: vi.fn().mockResolvedValue({ text: "Your compelling LinkedIn post goes here." }),
  checkBudget: vi.fn().mockResolvedValue(undefined),
  safeParseJson: vi.fn((text: string) => JSON.parse(text)),
}));

vi.mock("../../src/db/queries.js", () => ({
  hasBeenAudited: vi.fn().mockResolvedValue(false),
  writeAuditEntry: vi.fn().mockResolvedValue(undefined),
  writeTaskOutcome: vi.fn().mockResolvedValue(undefined),
  getRecentOutcomes: vi.fn().mockResolvedValue([]),
  publishDeptEvent: vi.fn().mockResolvedValue(undefined),
  consumePendingEvents: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../src/gateway/hitl.js", () => ({
  requestHITL: vi.fn().mockResolvedValue({
    interrupt_id: "test-interrupt",
    status: "pending",
  }),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeState(overrides: Record<string, unknown> = {}) {
  return {
    tenant_id: "turicks",
    trace_id: "trace-test-123",
    task: "Write a LinkedIn post about our new AI agent service",
    mktg_engineer_brief: {
      goal: "Generate 10 qualified demo requests",
      pillar: "Product Education",
      platform: "LinkedIn",
      format: "carousel",
      hook_strategy: "question",
      target_emotion: "curiosity",
      content_brief: "Show how Turicks AI reduces manual ops by 80%",
    },
    trend_report: "AI agents are trending. SaaS companies cutting costs with automation.",
    content_draft: null,
    hitl: null,
    final: null,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("contentWriterNode", () => {
  let callCascadeMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const llm = await import("../../src/infra/llm.js");
    callCascadeMock = llm.callCascade as ReturnType<typeof vi.fn>;
    callCascadeMock.mockResolvedValue({ text: "Your compelling LinkedIn carousel post:\n1. Did you know 80% of ops can be automated?\n2. Turicks AI makes it real." });
  });

  it("calls callCascade('md') to generate real content — not a stub", async () => {
    const { marketingSubgraph } = await import("../../src/agents/pods/marketing.js");

    const state = makeState();
    await marketingSubgraph.invoke(state, { configurable: { thread_id: "test-thread-1" } });

    // contentWriterNode should call callCascade
    expect(callCascadeMock).toHaveBeenCalled();

    // Find any call where agent = "content_writer"
    const writerCall = callCascadeMock.mock.calls.find(
      ([, , meta]: [string, unknown[], { agent: string }]) => meta?.agent === "content_writer",
    );
    expect(writerCall).toBeDefined();
  });

  it("includes platform and format from brief in the system prompt", async () => {
    const { marketingSubgraph } = await import("../../src/agents/pods/marketing.js");

    const state = makeState();
    await marketingSubgraph.invoke(state, { configurable: { thread_id: "test-thread-2" } });

    const writerCall = callCascadeMock.mock.calls.find(
      ([, , meta]: [string, unknown[], { agent: string }]) => meta?.agent === "content_writer",
    );
    expect(writerCall).toBeDefined();

    // The messages passed to callCascade should mention platform/format
    const messages = writerCall![1] as Array<{ content: string }>;
    const allText = messages.map((m) => m.content ?? "").join(" ");
    expect(allText).toMatch(/LinkedIn/i);
    expect(allText).toMatch(/carousel/i);
  });

  it("stores LLM output as content_draft (not the stub placeholder text)", async () => {
    const { marketingSubgraph } = await import("../../src/agents/pods/marketing.js");

    const state = makeState();
    const result = await marketingSubgraph.invoke(state, {
      configurable: { thread_id: "test-thread-3" },
    });

    // Should NOT contain old stub text
    expect(result.final?.content_draft ?? result.content_draft ?? "").not.toContain(
      "Phase 3: full content generation implemented here",
    );
  });

  it("falls back to a descriptive placeholder if LLM returns empty string", async () => {
    callCascadeMock.mockResolvedValueOnce({ text: "" }); // mktg_engineer empty
    callCascadeMock.mockResolvedValueOnce({ text: "" }); // content_writer empty

    const { marketingSubgraph } = await import("../../src/agents/pods/marketing.js");

    const state = makeState({ mktg_engineer_brief: null });
    const result = await marketingSubgraph.invoke(state, {
      configurable: { thread_id: "test-thread-4" },
    });

    // Fallback should still produce *some* non-empty draft
    const draft =
      (result.final as Record<string, unknown> | null)?.content_draft ??
      result.content_draft ??
      "";
    expect(typeof draft).toBe("string");
    expect((draft as string).length).toBeGreaterThan(0);
  });
});
