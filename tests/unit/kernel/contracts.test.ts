/**
 * v3 kernel contracts — parity + hostile-input tests.
 * The contracts ARE the architecture; these tests are the spec.
 */

import { describe, it, expect } from "vitest";
import {
  WORKERS,
  OUTPUT_CONTRACTS,
  isOutputSchemaRef,
  TaskEnvelopeSchema,
  PlanSchema,
  validatePlan,
  validateEnvelope,
  validateStepResult,
  hashToolArgs,
  digestToolResult,
  stableStringify,
  KERNEL_SCHEMA_VERSION,
  SIGNAL_EVENT_TYPES,
  type TaskEnvelope,
} from "../../../src/kernel/contracts.js";

const envelope = (over: Partial<TaskEnvelope> = {}): TaskEnvelope =>
  TaskEnvelopeSchema.parse({
    step_id: "s1",
    worker: "research",
    objective: "Research the latest LangGraph release notes",
    inputs: {},
    expected: { kind: "data", schema_ref: "research.findings" },
    constraints: { max_tool_calls: 2, hitl_required: false },
    ...over,
  });

const receipt = (ok = true) => ({
  tool: "send_email",
  args_hash: "a".repeat(64),
  result_digest: "b".repeat(64),
  ok,
  at: new Date().toISOString(),
});

describe("registry parity", () => {
  it("every signal event type has a signal.* output contract", () => {
    for (const ev of SIGNAL_EVENT_TYPES) {
      expect(isOutputSchemaRef(`signal.${ev}`), `signal.${ev} missing`).toBe(true);
    }
  });

  it("every registry entry is a usable Zod schema (safeParse is total)", () => {
    for (const [ref, schema] of Object.entries(OUTPUT_CONTRACTS)) {
      expect(() => schema.safeParse(null), ref).not.toThrow();
      expect(() => schema.safeParse({ hostile: { deeply: [null] } }), ref).not.toThrow();
    }
  });

  it("envelope rejects a schema_ref outside the registry", () => {
    const res = TaskEnvelopeSchema.safeParse({
      ...envelope(),
      expected: { kind: "data", schema_ref: "made.up" },
    });
    expect(res.success).toBe(false);
  });

  it("envelope rejects a worker outside the closed set", () => {
    const res = TaskEnvelopeSchema.safeParse({ ...envelope(), worker: "growth-hacking" });
    expect(res.success).toBe(false);
    expect(WORKERS).not.toContain("growth-hacking");
  });
});

describe("kind normalization — planner drift repair (live T02 regression)", () => {
  // LIVE FAILURE 2026-07-09: planner emitted expected.kind:"research.findings"
  // (the schema_ref value), which the strict enum rejected → the whole plan
  // died at the planning stage. kind must be repaired from schema_ref instead.
  it("repairs kind echoing the schema_ref (research.findings → data)", () => {
    const res = TaskEnvelopeSchema.safeParse({
      ...envelope(),
      expected: { kind: "research.findings", schema_ref: "research.findings" },
    });
    expect(res.success).toBe(true);
    expect(res.success && res.data.expected.kind).toBe("data");
  });

  it("derives draft from a draft.* schema_ref when kind is invalid", () => {
    const res = TaskEnvelopeSchema.safeParse({
      ...envelope(),
      worker: "comms",
      expected: { kind: "draft.email", schema_ref: "draft.email" },
    });
    expect(res.success).toBe(true);
    expect(res.success && res.data.expected.kind).toBe("draft");
  });

  it("derives action_receipt from action.summary when kind is invalid", () => {
    const res = TaskEnvelopeSchema.safeParse({
      ...envelope(),
      expected: { kind: "action.summary", schema_ref: "action.summary" },
    });
    expect(res.success).toBe(true);
    expect(res.success && res.data.expected.kind).toBe("action_receipt");
  });

  it("NEVER weakens a valid action_receipt the model emitted correctly", () => {
    const res = TaskEnvelopeSchema.safeParse({
      ...envelope(),
      expected: { kind: "action_receipt", schema_ref: "text.summary" },
    });
    expect(res.success).toBe(true);
    // untouched — the receipt safety check must still apply to this step.
    expect(res.success && res.data.expected.kind).toBe("action_receipt");
  });

  it("still rejects an unknown schema_ref regardless of kind repair", () => {
    const res = TaskEnvelopeSchema.safeParse({
      ...envelope(),
      expected: { kind: "made.up", schema_ref: "made.up" },
    });
    expect(res.success).toBe(false);
  });
});

describe("plan validation", () => {
  const plan = (steps: TaskEnvelope[]) => ({ schema_version: KERNEL_SCHEMA_VERSION, goal: "g", steps });

  it("accepts a valid multi-step plan", () => {
    const res = validatePlan(plan([envelope(), envelope({ step_id: "s2", worker: "comms" })]));
    expect(res.ok).toBe(true);
  });

  it("rejects duplicate step ids", () => {
    const res = validatePlan(plan([envelope(), envelope()]));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/unique/);
  });

  it("rejects empty, oversized, and hostile inputs without throwing", () => {
    expect(validatePlan(plan([])).ok).toBe(false);
    expect(validatePlan(plan(Array.from({ length: 9 }, (_, i) => envelope({ step_id: `s${i}` })))).ok).toBe(false);
    expect(validatePlan(null).ok).toBe(false);
    expect(validatePlan("a plan, trust me").ok).toBe(false);
    expect(validatePlan({ schema_version: 99, goal: "g", steps: [envelope()] }).ok).toBe(false);
  });

  it("rejects a vibes-only objective (min length)", () => {
    expect(validateEnvelope({ ...envelope(), objective: "do it" }).ok).toBe(false);
  });
});

describe("validateStepResult — the zero-hallucination gate", () => {
  it("accepts ok output matching the expected schema", () => {
    const res = validateStepResult(
      { status: "ok", step_id: "s1", output: { summary: "LangGraph 1.4 shipped", sources: [] }, tool_receipts: [] },
      envelope(),
    );
    expect(res.ok).toBe(true);
  });

  it("rejects ok output that does not satisfy the schema_ref", () => {
    const res = validateStepResult(
      { status: "ok", step_id: "s1", output: { wrong: true }, tool_receipts: [] },
      envelope(),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("research.findings");
  });

  it("rejects a claimed action with NO successful receipt (unproven action claim)", () => {
    const env = envelope({ expected: { kind: "action_receipt", schema_ref: "action.summary" } });
    const noReceipt = validateStepResult(
      { status: "ok", step_id: "s1", output: { summary: "email sent!" }, tool_receipts: [] },
      env,
    );
    expect(noReceipt.ok).toBe(false);
    if (!noReceipt.ok) expect(noReceipt.error).toMatch(/receipt/);

    const failedReceipt = validateStepResult(
      { status: "ok", step_id: "s1", output: { summary: "email sent!" }, tool_receipts: [receipt(false)] },
      env,
    );
    expect(failedReceipt.ok).toBe(false);
  });

  it("accepts an action WITH a successful receipt", () => {
    const env = envelope({ expected: { kind: "action_receipt", schema_ref: "action.summary" } });
    const res = validateStepResult(
      { status: "ok", step_id: "s1", output: { summary: "email sent" }, tool_receipts: [receipt(true)] },
      env,
    );
    expect(res.ok).toBe(true);
  });

  it("rejects step_id mismatch and passes failures through as valid results", () => {
    expect(
      validateStepResult({ status: "ok", step_id: "sX", output: { text: "t" }, tool_receipts: [] }, envelope()).ok,
    ).toBe(false);
    const failed = validateStepResult(
      {
        status: "failed",
        step_id: "s1",
        failure: {
          step_id: "s1",
          stage: "tool",
          component: "search_web",
          message: "Apify quota exhausted",
          retryable: true,
        },
      },
      envelope(),
    );
    expect(failed.ok).toBe(true);
  });

  it("is total on hostile input", () => {
    expect(validateStepResult(null, envelope()).ok).toBe(false);
    expect(validateStepResult({ status: "maybe" }, envelope()).ok).toBe(false);
  });
});

describe("receipt hashing determinism", () => {
  it("stableStringify sorts keys so hashes are order-independent", () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(stableStringify({ a: { c: 3, d: 2 }, b: 1 }));
    expect(hashToolArgs({ to: "x@y.z", subject: "hi" })).toBe(hashToolArgs({ subject: "hi", to: "x@y.z" }));
  });

  it("digest differs for different results and is 64 hex chars", () => {
    const d1 = digestToolResult({ ok: true });
    const d2 = digestToolResult({ ok: false });
    expect(d1).not.toBe(d2);
    expect(d1).toMatch(/^[0-9a-f]{64}$/);
  });
});
