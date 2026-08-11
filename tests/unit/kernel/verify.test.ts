import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyStepResult } from "../../../src/kernel/verify.js";
import { TaskEnvelopeSchema, StepResultSchema, type TaskEnvelope } from "../../../src/kernel/contracts.js";
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

const tmpDir = mkdtempSync(join(tmpdir(), "founderos-verify-"));
afterAll(() => rmSync(tmpDir, { recursive: true, force: true }));

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

  it("handles verifier throwing cleanly by returning a valid StepResult", async () => {
    const circular: any = {};
    circular.self = circular;
    const envelope = makeEnvelope();
    const result = makeOkResult(circular);
    const verified = await verifyStepResult(result, envelope);
    expect(verified.status).toBe("failed");
    if (verified.status === "failed") {
      expect(verified.failure.stage).toBe("validation");
      expect(verified.failure.message).toContain("Verifier threw error");
      const parsed = StepResultSchema.safeParse(verified);
      expect(parsed.success).toBe(true);
    }
  });

  describe("deliverable verification matrix (Phase 4)", () => {
    it("passes when CSV is requested and write_artifact receipt is present", async () => {
      const envelope = makeEnvelope({
        worker: "jobhunt",
        objective: "Export captured jobs to a CSV file",
        expected: { kind: "data", schema_ref: "text.summary" },
      });
      const result: StepResult = {
        status: "ok",
        step_id: "s1",
        output: { text: "Generated export at /data/artifacts/jobs.csv" },
        tool_receipts: [
          { tool: "job_state", args_hash: "h1", result_digest: "d1", ok: true, at: new Date().toISOString() },
          { tool: "write_artifact", args_hash: "h2", result_digest: "d2", ok: true, at: new Date().toISOString() },
        ],
      };
      const verified = await verifyStepResult(result, envelope);
      expect(verified.status).toBe("ok");
    });

    it("passes when file is requested and deliver_artifact receipt is present", async () => {
      const envelope = makeEnvelope({
        worker: "admin",
        objective: "Generate and send spreadsheet deliverable",
        expected: { kind: "data", schema_ref: "text.summary" },
      });
      const result: StepResult = {
        status: "ok",
        step_id: "s1",
        output: { text: "Delivered file to Telegram" },
        tool_receipts: [
          { tool: "deliver_artifact", args_hash: "h1", result_digest: "d1", ok: true, at: new Date().toISOString() },
        ],
      };
      const verified = await verifyStepResult(result, envelope);
      expect(verified.status).toBe("ok");
    });

    it("fails when CSV is requested but output is only an inline data dump without artifact receipts", async () => {
      const envelope = makeEnvelope({
        worker: "jobhunt",
        objective: "Give me a CSV of all captured jobs",
        expected: { kind: "data", schema_ref: "text.summary" },
      });
      const result: StepResult = {
        status: "ok",
        step_id: "s1",
        output: { text: "company,title,stage\nGoogle,SWE,applied\nMeta,AI,screened" },
        tool_receipts: [
          { tool: "job_state", args_hash: "h1", result_digest: "d1", ok: true, at: new Date().toISOString() },
        ],
      };
      const verified = await verifyStepResult(result, envelope);
      expect(verified.status).toBe("failed");
      if (verified.status === "failed") {
        expect(verified.failure.stage).toBe("validation");
        expect(verified.failure.message).toContain("no artifact was written or delivered");
      }
    });

    it("passes non-deliverable requests even without artifact receipts", async () => {
      const envelope = makeEnvelope({
        worker: "jobhunt",
        objective: "How many jobs are in the pipeline right now?",
        expected: { kind: "data", schema_ref: "text.summary" },
      });
      const result: StepResult = {
        status: "ok",
        step_id: "s1",
        output: { text: "There are 53 jobs in the pipeline." },
        tool_receipts: [
          { tool: "job_state", args_hash: "h1", result_digest: "d1", ok: true, at: new Date().toISOString() },
        ],
      };
      const verified = await verifyStepResult(result, envelope);
      expect(verified.status).toBe("ok");
    });
  });

  describe("worker-specific verifiers", () => {
    it("engineering verifier catches reported command failures", async () => {
      const envelope = makeEnvelope({
        worker: "engineering",
        objective: "Run test suite",
        expected: { kind: "data", schema_ref: "text.summary" },
      });
      const result = makeOkResult({ text: "Command failed with exit code 1" });
      const verified = await verifyStepResult(result, envelope);
      expect(verified.status).toBe("failed");
      if (verified.status === "failed") {
        expect(verified.failure.message).toContain("command failure");
      }
    });

    it("research verifier catches summaries with 0 sources", async () => {
      const envelope = makeEnvelope({
        worker: "research",
        objective: "Research AI agent frameworks in 2026",
        expected: { kind: "data", schema_ref: "research.findings" },
      });
      const result = makeOkResult({
        summary: "This is a detailed summary of modern AI agent architectures and emerging frameworks across the industry.",
        sources: [],
      });
      const verified = await verifyStepResult(result, envelope);
      expect(verified.status).toBe("failed");
      if (verified.status === "failed") {
        expect(verified.failure.message).toContain("zero source URLs");
      }
    });

    it("admin verifier accepts an object output whose text names a real path", async () => {
      const filePath = join(tmpDir, "q3_notes.md");
      writeFileSync(filePath, "# Q3 notes\n");
      const envelope = makeEnvelope({
        worker: "admin",
        objective: "Save the q3 notes artifact",
        expected: { kind: "data", schema_ref: "text.summary" },
      });
      // worker.ts finalizes with parsed JSON, so the verifier sees an OBJECT, not a plain string
      const result = makeOkResult({
        text: `✅ Artifact "q3_notes" (10 bytes, format: md) written successfully to ${filePath}`,
      });
      const verified = await verifyStepResult(result, envelope);
      expect(verified.status).toBe("ok");
    });

    it("admin verifier still fails when the named path does not exist", async () => {
      const missingPath = join(tmpDir, "does_not_exist.md");
      const envelope = makeEnvelope({
        worker: "admin",
        objective: "Save the q3 notes artifact",
        expected: { kind: "data", schema_ref: "text.summary" },
      });
      const result = makeOkResult({ text: `written successfully to ${missingPath}` });
      const verified = await verifyStepResult(result, envelope);
      expect(verified.status).toBe("failed");
      if (verified.status === "failed") {
        expect(verified.failure.message).toContain("does not exist on disk");
        expect(verified.failure.message).toContain(missingPath);
        expect(verified.failure.message).not.toContain('"}');
      }
    });

    it("jobhunt verifier catches missing count field on rows object", async () => {
      const envelope = makeEnvelope({
        worker: "jobhunt",
        objective: "Get job state summary",
        expected: { kind: "data", schema_ref: "data.generic" },
      });
      const result = makeOkResult({ rows: [{ id: "1", company: "Turicks" }] });
      const verified = await verifyStepResult(result, envelope);
      expect(verified.status).toBe("failed");
      if (verified.status === "failed") {
        expect(verified.failure.message).toContain("missing explicit count field");
      }
    });
  });
});
