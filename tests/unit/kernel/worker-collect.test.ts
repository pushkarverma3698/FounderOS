/**
 * collect() — finalize repair for pure-text contracts (live T01 regression).
 * LIVE FAILURE 2026-07-09: research worker answered with the prose summary
 * itself instead of {"text": …} → "Worker did not finalize with JSON" killed
 * an honest, correct answer. The prose IS the payload for text.summary; wrap
 * it in code. Structured contracts and the action-receipt gate are untouched.
 */

import { describe, it, expect } from "vitest";
import { AIMessage } from "@langchain/core/messages";
import { collect } from "../../../src/kernel/worker.js";
import { TaskEnvelopeSchema, type TaskEnvelope } from "../../../src/kernel/contracts.js";
import type { KernelStateType } from "../../../src/kernel/state.js";

const envelope = (over: Partial<TaskEnvelope> = {}): TaskEnvelope =>
  TaskEnvelopeSchema.parse({
    step_id: "s1",
    worker: "research",
    objective: "Research what Linear does and summarize it",
    inputs: {},
    expected: { kind: "data", schema_ref: "text.summary" },
    constraints: { max_tool_calls: 2, hitl_required: false },
    ...over,
  });

const stateWith = (step: TaskEnvelope, finalText: string): KernelStateType =>
  ({
    mission: { goal: "g", status: "executing", plan: { schema_version: 1, goal: "g", steps: [step] }, cursor: 0 },
    results: [],
    attempts: {},
    scratch: [new AIMessage(finalText)],
    step_receipts: [],
    failure: null,
    reply: "",
  }) as unknown as KernelStateType;

describe("collect — prose finalize repair (live T01 regression)", () => {
  it("wraps a prose finalize into {text} for text.summary and validates ok", () => {
    const prose = "Linear is a project management tool for software teams. It tracks issues and cycles.";
    const update = collect(stateWith(envelope(), prose));
    const result = update.results?.[0];
    expect(result?.status).toBe("ok");
    if (result?.status === "ok") expect(result.output).toEqual({ text: prose });
  });

  it("does NOT wrap prose for structured contracts (research.findings still fails loud)", () => {
    const step = envelope({ expected: { kind: "data", schema_ref: "research.findings" } });
    const update = collect(stateWith(step, "here are my findings as prose"));
    const result = update.results?.[0];
    // Depending on jsonrepair's salvage the failure is "did not finalize" or a
    // schema mismatch — either way it MUST fail loud, never silently wrap.
    expect(result?.status).toBe("failed");
    if (result?.status === "failed") {
      expect(result.failure.stage).toBe("validation");
      expect(result.failure.message).toMatch(/research\.findings/);
    }
  });

  it("prose wrap NEVER bypasses the action-receipt gate", () => {
    const step = envelope({ expected: { kind: "action_receipt", schema_ref: "text.summary" } });
    const update = collect(stateWith(step, "email sent, all done!"));
    const result = update.results?.[0];
    expect(result?.status).toBe("failed");
    if (result?.status === "failed") expect(result.failure.message).toMatch(/receipt/);
  });

  it("still fails when the worker produced no final text at all", () => {
    const update = collect(stateWith(envelope(), ""));
    expect(update.results?.[0]?.status).toBe("failed");
  });
});
