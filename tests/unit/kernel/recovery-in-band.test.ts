/**
 * Unit tests for Phase 5 — Recovery and Objective Ownership.
 * Tests partial failure recovery, receipt retention, and failure reply formatting.
 */

import { describe, it, expect } from "vitest";
import { formatFailureReply, dispatch } from "../../../src/kernel/supervisor.js";
import type { FailureReport, StepResult, Mission } from "../../../src/kernel/contracts.js";
import type { KernelStateType } from "../../../src/kernel/state.js";

describe("Phase 5 — Recovery and Objective Ownership", () => {
  it("formats failure reply with completed step evidence", () => {
    const failure: FailureReport = {
      step_id: "s3",
      stage: "tool",
      component: "tool:browser",
      message: "Browser navigation timeout",
      evidence: "HTTP 504 Gateway Timeout",
      retryable: false,
    };

    const results: StepResult[] = [
      { status: "ok", step_id: "s1", output: { text: "Fetched company URL" }, tool_receipts: [] },
      { status: "ok", step_id: "s2", output: { text: "Scraped pricing page" }, tool_receipts: [] },
    ];

    const reply = formatFailureReply(failure, results);
    expect(reply).toContain('Task stopped at step "s3"');
    expect(reply).toContain("tool:browser");
    expect(reply).toContain("Completed steps before failure:");
    expect(reply).toContain('• Step "s1": {"text":"Fetched company URL"}');
    expect(reply).toContain('• Step "s2": {"text":"Scraped pricing page"}');
    expect(reply).toContain("the mission is resumable");
  });

  it("retains step 1 and step 2 receipts when step 3 fails non-retryable", () => {
    const dummyConstraints = { max_tool_calls: 3, hitl_required: false };

    const state: KernelStateType = {
      turn: { id: "t1", chat_id: "c1", received_at: "", raw_input: "Do multi-step task" },
      mission: {
        goal: "Do multi-step task",
        status: "executing",
        cursor: 2,
        plan: {
          schema_version: 1,
          goal: "Do multi-step task",
          steps: [
            { step_id: "s1", worker: "research", objective: "Step 1 research", inputs: {}, expected: { kind: "data", schema_ref: "data.generic" }, constraints: dummyConstraints },
            { step_id: "s2", worker: "admin", objective: "Step 2 admin", inputs: {}, expected: { kind: "action_receipt", schema_ref: "action.summary" }, constraints: dummyConstraints },
            { step_id: "s3", worker: "comms", objective: "Step 3 comms", inputs: {}, expected: { kind: "draft", schema_ref: "draft.email" }, constraints: dummyConstraints },
          ],
        },
      },
      results: [
        { status: "ok", step_id: "s1", output: "Step 1 data", tool_receipts: [] },
        { status: "ok", step_id: "s2", output: "Step 2 data", tool_receipts: [] },
        {
          status: "failed",
          step_id: "s3",
          failure: {
            step_id: "s3",
            stage: "validation",
            component: "kernel/verify:comms",
            message: "Unresolved placeholder in draft",
            retryable: false,
          },
        },
      ],
      attempts: { s1: 1, s2: 1, s3: 1 },
      failure: null,
      scratch: {},
      step_receipts: {},
      reply: "",
      lesson_candidate: null,
      last_turn: null,
      history: [],
    };

    const update = dispatch(state);
    const missionUpdate = update.mission as Mission | undefined;
    expect(missionUpdate?.status).toBe("failed");
    expect(update.reply).toContain('Task stopped at step "s3"');
    expect(update.reply).toContain('Step "s1"');
    expect(update.reply).toContain('Step "s2"');
  });
});
