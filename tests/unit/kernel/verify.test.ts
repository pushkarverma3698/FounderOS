import { describe, it, expect } from "vitest";
import { verifyStepResult } from "../../../src/kernel/verify.js";
import { TaskEnvelopeSchema, type TaskEnvelope } from "../../../src/kernel/contracts.js";
import type { StepResult } from "../../../src/kernel/contracts.js";

const makeEnvelope = (over: Partial<TaskEnvelope> = {}): TaskEnvelope =>
  TaskEnvelopeSchema.parse({
    step_id: "s1",
    worker: "comms",
    objective: "Draft an email to the team",
    inputs: {},
    expected: { kind: "draft", schema_ref: "draft.email" },
    constraints: { max_tool_calls: 1, hitl_required: false },
    ...over,
  });

const makeOkResult = (output: unknown): StepResult => ({
  status: "ok",
  step_id: "s1",
  output,
  tool_receipts: [],
});

describe("verifyStepResult", () => {
  it("passes valid drafts without placeholders", async () => {
    const envelope = makeEnvelope();
    const result = makeOkResult({ to: "team@x.dev", subject: "Update", body: "Hello team, here is the update." });
    const verified = await verifyStepResult(result, envelope);
    expect(verified.status).toBe("ok");
  });

  it("fails drafts containing brace template placeholders (e.g. {{name}})", async () => {
    const envelope = makeEnvelope();
    const result = makeOkResult({ to: "team@x.dev", subject: "Update", body: "Hello {{name}}, here is the update." });
    const verified = await verifyStepResult(result, envelope);
    expect(verified.status).toBe("failed");
    if (verified.status === "failed") {
      expect(verified.failure.stage).toBe("validation");
      expect(verified.failure.message).toMatch(/template placeholders/);
    }
  });

  it("fails drafts containing bracket placeholders (e.g. [Recipient])", async () => {
    const envelope = makeEnvelope();
    const result = makeOkResult({ to: "team@x.dev", subject: "Update", body: "Hello [Recipient], here is the update." });
    const verified = await verifyStepResult(result, envelope);
    expect(verified.status).toBe("failed");
    if (verified.status === "failed") {
      expect(verified.failure.stage).toBe("validation");
    }
  });
});
