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
import { TaskEnvelopeSchema, type TaskEnvelope, type StepResult } from "../../../src/kernel/contracts.js";
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
    scratch: { s1: [new AIMessage(finalText)] },
    step_receipts: { s1: [] },
    failure: null,
    reply: "",
  }) as unknown as KernelStateType;

describe("collect — prose finalize repair (live T01 regression)", () => {
  it("wraps a prose finalize into {text} for text.summary and validates ok", async () => {
    const prose = "Linear is a project management tool for software teams. It tracks issues and cycles.";
    const update = await collect(stateWith(envelope(), prose));
    const results = update.results as StepResult[] | undefined;
    const result = results?.[0];
    expect(result?.status).toBe("ok");
    if (result?.status === "ok") expect(result.output).toEqual({ text: prose });
  });

  it("does NOT wrap prose for structured contracts (research.findings still fails loud)", async () => {
    const step = envelope({ expected: { kind: "data", schema_ref: "research.findings" } });
    const update = await collect(stateWith(step, "here are my findings as prose"));
    const results = update.results as StepResult[] | undefined;
    const result = results?.[0];
    // Depending on jsonrepair's salvage the failure is "did not finalize" or a
    // schema mismatch — either way it MUST fail loud, never silently wrap.
    expect(result?.status).toBe("failed");
    if (result?.status === "failed") {
      expect(result.failure.stage).toBe("validation");
      expect(result.failure.message).toMatch(/research\.findings/);
    }
  });

  it("prose wrap NEVER bypasses the action-receipt gate", async () => {
    const step = envelope({ expected: { kind: "action_receipt", schema_ref: "text.summary" } });
    const update = await collect(stateWith(step, "email sent, all done!"));
    const results = update.results as StepResult[] | undefined;
    const result = results?.[0];
    expect(result?.status).toBe("failed");
    if (result?.status === "failed") expect(result.failure.message).toMatch(/receipt/);
  });

  it("still fails when the worker produced no final text at all", async () => {
    const update = await collect(stateWith(envelope(), ""));
    const results = update.results as StepResult[] | undefined;
    expect(results?.[0]?.status).toBe("failed");
  });
});

/**
 * LIVE FAILURE 2026-07-11 d211fb74 + 2026-07-12 8c7e098f (build a2b4979):
 * gemini-flash-latest returned the finalize as an ARRAY of content parts;
 * collect() extracted "" and killed honest answers with "did not finalize".
 */
describe("collect — parts-array finalize (live d211fb74 regression)", () => {
  const stateWithContent = (step: TaskEnvelope, content: unknown): KernelStateType =>
    ({
      mission: { goal: "g", status: "executing", plan: { schema_version: 1, goal: "g", steps: [step] }, cursor: 0 },
      results: [],
      attempts: {},
      scratch: { s1: [new AIMessage({ content: content as never })] },
      step_receipts: { s1: [] },
      failure: null,
      reply: "",
    }) as unknown as KernelStateType;

  it("salvages a prose finalize delivered as content parts for text.summary", async () => {
    const update = await collect(
      stateWithContent(envelope(), [{ type: "text", text: "The pending action is the LinkedIn approval." }]),
    );
    const results = update.results as StepResult[] | undefined;
    const result = results?.[0];
    expect(result?.status).toBe("ok");
    if (result?.status === "ok") {
      expect(result.output).toEqual({ text: "The pending action is the LinkedIn approval." });
    }
  });

  it("parses a JSON finalize delivered as content parts for structured contracts", async () => {
    const step = envelope({ expected: { kind: "data", schema_ref: "research.findings" } });
    const update = await collect(
      stateWithContent(step, [
        { type: "text", text: '{"summary":"Linear ships fast","sources":[{"title":"Linear blog"}]}' },
      ]),
    );
    const results = update.results as StepResult[] | undefined;
    const result = results?.[0];
    expect(result?.status).toBe("ok");
  });
});

describe("collect — output unwrapping and coercion (battery test failures)", () => {
  const stateWith = (step: TaskEnvelope, finalText: string): KernelStateType =>
    ({
      mission: { goal: "g", status: "executing", plan: { schema_version: 1, goal: "g", steps: [step] }, cursor: 0 },
      results: [],
      attempts: {},
      scratch: { s1: [new AIMessage(finalText)] },
      step_receipts: { s1: [] },
      failure: null,
      reply: "",
    }) as unknown as KernelStateType;

  it("unwraps research.findings wrapped under key research.findings", async () => {
    const step = envelope({ expected: { kind: "data", schema_ref: "research.findings" } });
    const wrapped = JSON.stringify({
      "research.findings": {
        summary: "Linear is great",
        sources: [{ title: "Linear website", url: "https://linear.app" }]
      }
    });
    const update = await collect(stateWith(step, wrapped));
    const results = update.results as StepResult[] | undefined;
    const result = results?.[0];
    expect(result?.status).toBe("ok");
    if (result?.status === "ok") {
      expect(result.output).toEqual({
        summary: "Linear is great",
        sources: [{ title: "Linear website", url: "https://linear.app" }]
      });
    }
  });

  it("unwraps action.summary wrapped under key action", async () => {
    const step = envelope({ expected: { kind: "data", schema_ref: "action.summary" } });
    const wrapped = JSON.stringify({
      action: {
        summary: "Database migrated successfully"
      }
    });
    const update = await collect(stateWith(step, wrapped));
    const results = update.results as StepResult[] | undefined;
    const result = results?.[0];
    expect(result?.status).toBe("ok");
    if (result?.status === "ok") {
      expect(result.output).toEqual({
        summary: "Database migrated successfully"
      });
    }
  });

  it("coerces text -> body for draft.linkedin_post", async () => {
    const step = envelope({ expected: { kind: "data", schema_ref: "draft.linkedin_post" } });
    const payload = JSON.stringify({
      text: "This is a great new feature in FounderOS!"
    });
    const update = await collect(stateWith(step, payload));
    const results = update.results as StepResult[] | undefined;
    const result = results?.[0];
    expect(result?.status).toBe("ok");
    if (result?.status === "ok") {
      expect(result.output).toEqual({
        body: "This is a great new feature in FounderOS!"
      });
    }
  });

  it("coerces text -> summary for action.summary", async () => {
    const step = envelope({ expected: { kind: "data", schema_ref: "action.summary" } });
    const payload = JSON.stringify({
      text: "Removed old logs"
    });
    const update = await collect(stateWith(step, payload));
    const results = update.results as StepResult[] | undefined;
    const result = results?.[0];
    expect(result?.status).toBe("ok");
    if (result?.status === "ok") {
      expect(result.output).toEqual({
        summary: "Removed old logs"
      });
    }
  });

  it("coerces text -> summary for research.findings", async () => {
    const step = envelope({ expected: { kind: "data", schema_ref: "research.findings" } });
    const payload = JSON.stringify({
      text: "Found 3 open issues",
      sources: []
    });
    const update = await collect(stateWith(step, payload));
    const results = update.results as StepResult[] | undefined;
    const result = results?.[0];
    expect(result?.status).toBe("ok");
    if (result?.status === "ok") {
      expect(result.output).toEqual({
        summary: "Found 3 open issues",
        sources: []
      });
    }
  });
});
