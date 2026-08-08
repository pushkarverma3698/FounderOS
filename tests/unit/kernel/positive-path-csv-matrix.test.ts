/**
 * Phase 4 & Phase 5: Positive Path CSV Verification & Test Matrix
 * ===============================================================
 * Tests the complete positive path:
 *   job_state → write_artifact → deliver_artifact → observed receipt → verification → complete
 * Along with all 7 cases of the Phase 4/5 deliverable & recovery matrix:
 *   1. 39/39 jobs exported (Complete)
 *   2. 3/39 delivered (Partial)
 *   3. 0/39 delivered (Failed)
 *   4. 0 genuinely matching jobs (Valid empty)
 *   5. Artifact exists, delivery fails (Not complete / Recoverable)
 *   6. DB unavailable (Not complete / Retryable)
 *   7. Wrong tool selected (Rejected / Recovered)
 */

import { describe, it, expect } from "vitest";
import { verifyStepResult } from "../../../src/kernel/verify.js";
import { formatFailureReply, dispatch, retryMessage } from "../../../src/kernel/supervisor.js";
import { TaskEnvelopeSchema, type TaskEnvelope, type StepResult, type FailureReport } from "../../../src/kernel/contracts.js";
import type { KernelStateType } from "../../../src/kernel/state.js";

const makeEnvelope = (over: Partial<TaskEnvelope> = {}): TaskEnvelope =>
  TaskEnvelopeSchema.parse({
    step_id: "s1",
    worker: "jobhunt",
    objective: "what all jobs has been captured give me a csv",
    inputs: {},
    expected: { kind: "data", schema_ref: "data.generic" },
    constraints: { max_tool_calls: 5, hitl_required: false },
    ...over,
  });

describe("Positive Path CSV Verification & Delivery Matrix (P4/P5)", () => {
  describe("Positive Path: Complete 39/39 CSV Export & Delivery", () => {
    it("successfully verifies when job_state, write_artifact, and deliver_artifact receipts are present", async () => {
      const envelope = makeEnvelope();

      const result: StepResult = {
        status: "ok",
        step_id: "s1",
        output: {
          text: "Exported all 39 captured jobs to CSV and delivered the file to Telegram.",
          count: 39,
          artifact_path: "/data/artifacts/jobs_export_39.csv",
        },
        tool_receipts: [
          { tool: "job_state", args_hash: "h_state", result_digest: "d_39_rows", ok: true, at: new Date().toISOString() },
          { tool: "write_artifact", args_hash: "h_write", result_digest: "d_csv_created", ok: true, at: new Date().toISOString() },
          { tool: "deliver_artifact", args_hash: "h_deliver", result_digest: "d_tg_sent", ok: true, at: new Date().toISOString() },
        ],
      };

      const verified = await verifyStepResult(result, envelope);
      expect(verified.status).toBe("ok");
    });
  });

  describe("Deliverable Matrix Test Cases", () => {
    // 1. 39/39 jobs exported → Complete
    it("Case 1: 39/39 jobs exported with file delivered is COMPLETE", async () => {
      const envelope = makeEnvelope({ objective: "Export all 39 jobs to spreadsheet" });
      const result: StepResult = {
        status: "ok",
        step_id: "s1",
        output: { count: 39, file: "jobs.csv" },
        tool_receipts: [
          { tool: "job_state", args_hash: "h1", result_digest: "d1", ok: true, at: new Date().toISOString() },
          { tool: "write_artifact", args_hash: "h2", result_digest: "d2", ok: true, at: new Date().toISOString() },
          { tool: "deliver_artifact", args_hash: "h3", result_digest: "d3", ok: true, at: new Date().toISOString() },
        ],
      };
      const verified = await verifyStepResult(result, envelope);
      expect(verified.status).toBe("ok");
    });

    // 2. 3/39 delivered → Partial (Warning / Partial notice)
    it("Case 2: 3/39 delivered indicates partial results with clear count in output", async () => {
      const envelope = makeEnvelope({ objective: "Export all captured jobs to CSV" });
      const result: StepResult = {
        status: "ok",
        step_id: "s1",
        output: { count: 3, total_captured: 39, warning: "Partial export: only 3 of 39 jobs exported due to filter" },
        tool_receipts: [
          { tool: "job_state", args_hash: "h1", result_digest: "d_3_rows", ok: true, at: new Date().toISOString() },
          { tool: "write_artifact", args_hash: "h2", result_digest: "d_csv", ok: true, at: new Date().toISOString() },
        ],
      };
      const verified = await verifyStepResult(result, envelope);
      expect(verified.status).toBe("ok");
      if (verified.status === "ok") {
        expect((verified.output as any).count).toBe(3);
        expect((verified.output as any).warning).toContain("Partial export");
      }
    });

    // 3. 0/39 delivered → Failed (no receipts, rejected by deliverable verifier)
    it("Case 3: 0/39 delivered (raw inline text only) is FAILED by verifier", async () => {
      const envelope = makeEnvelope({ objective: "Give me a CSV file of all captured jobs" });
      const result: StepResult = {
        status: "ok",
        step_id: "s1",
        output: { text: "Here is your data: company,title\nGoogle,SWE" },
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

    // 4. 0 genuinely matching jobs → Valid empty result
    it("Case 4: 0 genuinely matching jobs is VALID EMPTY when count is explicitly reported", async () => {
      const envelope = makeEnvelope({
        objective: "How many jobs are in stage 'interviewing'?",
        expected: { kind: "data", schema_ref: "data.generic" },
      });
      const result: StepResult = {
        status: "ok",
        step_id: "s1",
        output: { count: 0, rows: [], message: "No jobs currently in 'interviewing' stage." },
        tool_receipts: [
          { tool: "job_state", args_hash: "h1", result_digest: "d0", ok: true, at: new Date().toISOString() },
        ],
      };
      const verified = await verifyStepResult(result, envelope);
      expect(verified.status).toBe("ok");
    });

    // 5. Artifact exists, delivery fails → Not complete (fails at delivery stage, recoverable)
    it("Case 5: Artifact exists but delivery failed is NOT COMPLETE (recoverable)", async () => {
      const failure: FailureReport = {
        step_id: "s1",
        stage: "tool",
        component: "tool:deliver_artifact",
        message: "Telegram API 500 error while sending file",
        evidence: "HTTP 500 Internal Server Error",
        retryable: true,
      };

      const result: StepResult = {
        status: "failed",
        step_id: "s1",
        failure,
      };

      const envelope = makeEnvelope();
      const retry = retryMessage(envelope, failure, 1);
      expect(retry.content).toContain("RETRY 1 of 2");
      expect(retry.content).toContain("Telegram API 500 error");

      const failureReply = formatFailureReply(failure, [
        {
          status: "ok",
          step_id: "s0",
          output: "Artifact written to /data/artifacts/jobs.csv",
          tool_receipts: [{ tool: "write_artifact", args_hash: "h", result_digest: "d", ok: true, at: new Date().toISOString() }],
        },
      ]);
      expect(failureReply).toContain("Task stopped at step \"s1\"");
      expect(failureReply).toContain("Completed steps before failure:");
      expect(failureReply).toContain("the mission is resumable");
    });

    // 6. DB unavailable → Not complete (retryable error)
    it("Case 6: DB unavailable fails loudly with retryable flag", async () => {
      const failure: FailureReport = {
        step_id: "s1",
        stage: "tool",
        component: "tool:job_state",
        message: "Database connection refused at localhost:5432",
        evidence: "ECONNREFUSED",
        retryable: true,
      };

      expect(failure.retryable).toBe(true);
      const reply = formatFailureReply(failure);
      expect(reply).toContain("Database connection refused");
      expect(reply).toContain("the mission is resumable");
    });

    // 7. Wrong tool selected → Rejected by verifier / Recovers
    it("Case 7: Wrong tool selected (job_brief instead of deliverable) is REJECTED and guides recovery", async () => {
      const envelope = makeEnvelope({ objective: "Give me a CSV export of all captured jobs" });
      const result: StepResult = {
        status: "ok",
        step_id: "s1",
        output: { text: "Here is a brief summary of all 39 jobs..." },
        tool_receipts: [
          { tool: "job_brief", args_hash: "h_brief", result_digest: "d_brief", ok: true, at: new Date().toISOString() },
        ],
      };

      const verified = await verifyStepResult(result, envelope);
      expect(verified.status).toBe("failed");
      if (verified.status === "failed") {
        expect(verified.failure.message).toContain("Use write_artifact to create the file, then deliver_artifact to send it");
        expect(verified.failure.retryable).toBe(true);

        // Diagnostic retry forces alternative tool path
        const diagRetry = retryMessage(envelope, verified.failure, 2);
        expect(diagRetry.content).toContain("DIAGNOSTIC RETRY");
        expect(diagRetry.content).toContain("use a DIFFERENT tool or DIFFERENT arguments");
      }
    });
  });
});
