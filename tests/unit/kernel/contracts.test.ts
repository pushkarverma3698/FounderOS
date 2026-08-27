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
  StepResultSchema,
  hashToolArgs,
  digestToolResult,
  repairDataGenericOutput,
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

  it("envelope rejects an unknown side-effecting schema_ref (draft.*)", () => {
    const res = TaskEnvelopeSchema.safeParse({
      ...envelope(),
      expected: { kind: "draft", schema_ref: "draft.made_up" },
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

  it("still rejects an unknown schema_ref on an explicit action_receipt step", () => {
    const res = TaskEnvelopeSchema.safeParse({
      ...envelope(),
      expected: { kind: "action_receipt", schema_ref: "send.made_up" },
    });
    expect(res.success).toBe(false);
  });
});

describe("schema_ref drift repair — planner invents data refs (live 2026-07-11 regression)", () => {
  // LIVE FAILURE 2026-07-11 18:33 (turnId 9ad11675): the planner emitted
  // invented data-shaped schema_refs for two summary steps → "unknown output
  // schema_ref" killed the ENTIRE plan at the planning stage. Same drift
  // family as kind-echo (T02): repair in code, never in the prompt.
  it("repairs an unknown data-kind schema_ref to data.generic", () => {
    const res = TaskEnvelopeSchema.safeParse({
      ...envelope(),
      expected: { kind: "data", schema_ref: "github.commit_list" },
    });
    expect(res.success).toBe(true);
    expect(res.success && res.data.expected.schema_ref).toBe("data.generic");
    expect(res.success && res.data.expected.kind).toBe("data");
  });

  it("repairs when kind AND schema_ref both drifted", () => {
    const res = TaskEnvelopeSchema.safeParse({
      ...envelope(),
      expected: { kind: "features.list", schema_ref: "features.list" },
    });
    expect(res.success).toBe(true);
    expect(res.success && res.data.expected.schema_ref).toBe("data.generic");
    expect(res.success && res.data.expected.kind).toBe("data");
  });

  it("NEVER remaps an unknown draft.* ref — draft contracts feed HITL previews", () => {
    const res = TaskEnvelopeSchema.safeParse({
      ...envelope(),
      expected: { kind: "draft", schema_ref: "draft.tweet" },
    });
    expect(res.success).toBe(false);
  });

  it("NEVER remaps an unknown ref on an action_receipt step — receipt gate stays intact", () => {
    const res = TaskEnvelopeSchema.safeParse({
      ...envelope(),
      expected: { kind: "action_receipt", schema_ref: "email.sent" },
    });
    expect(res.success).toBe(false);
  });
});

describe("text.summary shape repair (live T01/T03 regression)", () => {
  // LIVE FAILURE 2026-07-09: comms worker emitted {"summary": …} where the
  // contract wants {"text": …} — same honest content, wrong field name. The
  // shape is repaired in code; content is never altered or invented.
  it("normalizes {summary} to {text} through validateStepResult", () => {
    const msg = "Failed to read unread emails: gws auth missing.";
    const res = validateStepResult(
      { status: "ok", step_id: "s1", output: { summary: msg }, tool_receipts: [] },
      envelope({ expected: { kind: "data", schema_ref: "text.summary" } }),
    );
    expect(res.ok).toBe(true);
    if (res.ok && res.value.status === "ok") expect(res.value.output).toEqual({ text: msg });
  });

  it("wraps a bare JSON-string answer into {text}", () => {
    const parsed = OUTPUT_CONTRACTS["text.summary"]!.safeParse("Linear builds issue tracking.");
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual({ text: "Linear builds issue tracking." });
  });

  it("leaves a correct {text} untouched", () => {
    const parsed = OUTPUT_CONTRACTS["text.summary"]!.safeParse({ text: "already right" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual({ text: "already right" });
  });

  it("still rejects empty and content-free outputs", () => {
    expect(OUTPUT_CONTRACTS["text.summary"]!.safeParse({}).success).toBe(false);
    expect(OUTPUT_CONTRACTS["text.summary"]!.safeParse({ summary: "" }).success).toBe(false);
    expect(OUTPUT_CONTRACTS["text.summary"]!.safeParse("").success).toBe(false);
  });
});

describe("constraints repair — planner drops the field (live 2026-07-13 regression)", () => {
  const raw = (over: Record<string, unknown> = {}) => ({
    step_id: "s1",
    worker: "admin",
    objective: "List all scheduled tasks and identify the recurrence",
    inputs: {},
    expected: { kind: "data", schema_ref: "text.summary" },
    ...over,
  });

  it("fills a MISSING constraints object with a safe tool budget + hitl=false for data steps", () => {
    // The exact live failure: a step with no `constraints` key → planner validation rejected it.
    const res = TaskEnvelopeSchema.safeParse(raw());
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.constraints.max_tool_calls).toBe(3);
      expect(res.data.constraints.hitl_required).toBe(false);
    }
  });

  it("defaults hitl_required=TRUE for an action step (fail safe — a dropped gate must not auto-send)", () => {
    const res = TaskEnvelopeSchema.safeParse(
      raw({ worker: "comms", objective: "Send the recap email", expected: { kind: "action_receipt", schema_ref: "action.summary" } }),
    );
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.constraints.hitl_required).toBe(true);
  });

  it("infers action-step gating from schema_ref even when kind is also dropped", () => {
    const res = TaskEnvelopeSchema.safeParse(raw({ expected: { schema_ref: "action.summary" } }));
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.constraints.hitl_required).toBe(true);
  });

  it("fills only the MISSING key when constraints is partial", () => {
    const res = TaskEnvelopeSchema.safeParse(raw({ constraints: { max_tool_calls: 5 } }));
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.constraints.max_tool_calls).toBe(5); // author's value kept
      expect(res.data.constraints.hitl_required).toBe(false); // dropped key filled
    }
  });

  it("leaves a fully-formed envelope byte-identical (determinism)", () => {
    const good = { ...raw(), constraints: { max_tool_calls: 2, hitl_required: false } };
    const a = TaskEnvelopeSchema.parse(good);
    const b = TaskEnvelopeSchema.parse(good);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.constraints).toEqual({ max_tool_calls: 2, hitl_required: false });
  });

  it("a repaired plan now validates end-to-end where it previously failed", () => {
    const step = raw(); // no constraints — the shape from the live trace
    const res = validatePlan({ schema_version: KERNEL_SCHEMA_VERSION, goal: "check recurrence", steps: [step] });
    expect(res.ok).toBe(true);
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

// The failed branch used to have NO tool_receipts field at all — a step that
// failed after a tool ran lost the receipt entirely (docs/EVAL-AUDIT-2026-08-28.md
// D1). These pin the fix: additive, defaulted, and doesn't disturb a caller
// that never mentions the field.
describe("StepResultSchema — failed branch carries tool_receipts (D1)", () => {
  it("accepts a failed result that omits tool_receipts and defaults it to []", () => {
    const res = StepResultSchema.safeParse({
      status: "failed",
      step_id: "s1",
      failure: { step_id: "s1", stage: "tool", component: "x", message: "boom", retryable: true },
    });
    expect(res.success).toBe(true);
    if (res.success && res.data.status === "failed") {
      expect(res.data.tool_receipts).toEqual([]);
    }
  });

  it("accepts a failed result that carries real receipts earned before it failed", () => {
    const res = StepResultSchema.safeParse({
      status: "failed",
      step_id: "s1",
      failure: { step_id: "s1", stage: "validation", component: "x", message: "bad output", retryable: true },
      tool_receipts: [receipt(true)],
    });
    expect(res.success).toBe(true);
    if (res.success && res.data.status === "failed") {
      expect(res.data.tool_receipts).toHaveLength(1);
      expect(res.data.tool_receipts[0]!.tool).toBe("send_email");
    }
  });

  it("validateStepResult still passes a failed result through untouched by output validation", () => {
    const res = validateStepResult(
      {
        status: "failed",
        step_id: "s1",
        failure: { step_id: "s1", stage: "tool", component: "x", message: "boom", retryable: true },
        tool_receipts: [receipt(true)],
      },
      envelope(),
    );
    expect(res.ok).toBe(true);
    if (res.ok && res.value.status === "failed") {
      expect(res.value.tool_receipts).toHaveLength(1);
    }
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

describe("repairDataGenericOutput", () => {
  it("wraps raw prose markdown text into { data: text } when model outputs non-JSON prose", () => {
    const repaired = repairDataGenericOutput(null, "Here are the recent changes to FounderOS:\n- AG-007\n- M0a");
    expect(repaired).toEqual({ data: "Here are the recent changes to FounderOS:\n- AG-007\n- M0a" });
  });
});
