/**
 * Supervisor node — routing parse resilience (regression guard).
 *
 * Lesson from the CEO live battery (2026-05-31): the CEO prompt used to echo the
 * full task into its JSON verdict, which overflowed the token cap and truncated
 * the JSON mid-string → empty agent → unroutable. The verdict is now COMPACT
 * (no task echo). These tests pin that contract: a compact CEO response must
 * route correctly, and the supervisor must fall back to state.task.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const callCascadeMock = vi.fn();

vi.mock("../../src/infra/llm.js", () => ({
  callCascade: (...args: unknown[]) => callCascadeMock(...args),
  checkBudget: vi.fn().mockResolvedValue(undefined),
}));

import { supervisorNode } from "../../src/agents/supervisor.js";

function baseState(task: string) {
  return {
    schema_version: 1,
    trace_id: "t-1",
    tenant_id: "turicks",
    messages: [],
    task,
    department: "",
    result: "",
    outreach_tier: null,
    auto_approve: false,
    departmentSignals: [],
    errors: [],
  };
}

describe("supervisorNode — compact CEO verdict routing", () => {
  beforeEach(() => callCascadeMock.mockReset());

  it("routes a compact verdict (no task field) to the right department", async () => {
    callCascadeMock.mockResolvedValue({
      text: '{"company":"turicks","agent":"bdr","direct_answer":null}',
      model: "gemini-2.5-flash",
      provider: "google",
      tier: "ceo",
      tokensIn: 100,
      tokensOut: 20,
      costUsd: 0,
    });

    const out = await supervisorNode(baseState("Write a cold email to Stripe"));
    expect(out.department).toBe("sales");
    // Task is preserved from state even though the CEO verdict omitted it.
    expect(out.task).toBe("Write a cold email to Stripe");
  });

  it("routes engineering verdicts", async () => {
    callCascadeMock.mockResolvedValue({
      text: '{"company":"turicks","agent":"senior_dev","direct_answer":null}',
      model: "gemini-2.5-flash", provider: "google", tier: "ceo", tokensIn: 80, tokensOut: 15, costUsd: 0,
    });
    const out = await supervisorNode(baseState("Build a webhook endpoint"));
    expect(out.department).toBe("engineering");
  });

  it("ends gracefully (empty department) when no agent fits", async () => {
    callCascadeMock.mockResolvedValue({
      text: '{"company":"turicks","agent":"","direct_answer":"No matching agent."}',
      model: "gemini-2.5-flash", provider: "google", tier: "ceo", tokensIn: 80, tokensOut: 15, costUsd: 0,
    });
    const out = await supervisorNode(baseState("What is the weather?"));
    expect(out.department).toBe("");
  });

  it("tolerates markdown-fenced JSON from the model", async () => {
    callCascadeMock.mockResolvedValue({
      text: '```json\n{"company":"turicks","agent":"social_handler","direct_answer":null}\n```',
      model: "gemini-2.5-flash", provider: "google", tier: "ceo", tokensIn: 80, tokensOut: 15, costUsd: 0,
    });
    const out = await supervisorNode(baseState("Post on LinkedIn"));
    expect(out.department).toBe("social");
  });
});
