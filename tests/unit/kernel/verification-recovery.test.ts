/**
 * Unit tests for Phase 4 — Verification and the End of False Success.
 * Tests VERIFIERS map for all 8 workers, missionSatisfied check, and writeTaskOutcome.
 */

import { describe, it, expect } from "vitest";
import { VERIFIERS } from "../../../src/kernel/verify.js";
import { missionSatisfied } from "../../../src/kernel/mission-satisfaction.js";
import type { TaskEnvelope, StepResult } from "../../../src/kernel/contracts.js";

const dummyConstraints = { max_tool_calls: 3, hitl_required: false };

describe("Phase 4 — Verification & False Success Elimination", () => {
  describe("VERIFIERS Coverage (All 8 Workers)", () => {
    it("has verifiers registered for all 8 workers", () => {
      const expectedWorkers = [
        "admin", "research", "comms", "engineering", "marketing", "sales", "personal", "jobhunt",
      ];
      for (const w of expectedWorkers) {
        expect(VERIFIERS[w]).toBeDefined();
      }
    });

    it("comms verifier rejects template placeholders", async () => {
      const envelope: TaskEnvelope = {
        step_id: "s1",
        worker: "comms",
        objective: "Draft an outreach email to recipient",
        inputs: {},
        expected: { kind: "draft", schema_ref: "draft.email" },
        constraints: dummyConstraints,
      };
      const badResult = await VERIFIERS["comms"]!.verify({ text: "Hello {{name}}, welcome!" }, envelope);
      expect(badResult.ok).toBe(false);
      expect(badResult.error).toContain("unresolved template placeholders");

      const goodResult = await VERIFIERS["comms"]!.verify({ text: "Hello Alice, welcome!" }, envelope);
      expect(goodResult.ok).toBe(true);
    });

    it("admin verifier rejects non-existent or 0-byte artifact path", async () => {
      const envelope: TaskEnvelope = {
        step_id: "s1",
        worker: "admin",
        objective: "Write persistent deliverable artifact",
        inputs: {},
        expected: { kind: "action_receipt", schema_ref: "action.summary" },
        constraints: dummyConstraints,
      };
      const missingResult = await VERIFIERS["admin"]!.verify("written successfully to /tmp/nonexistent_xyz.md", envelope);
      expect(missingResult.ok).toBe(false);
      expect(missingResult.error).toContain("does not exist on disk");
    });

    it("jobhunt verifier rejects result missing count field on record rows", async () => {
      const envelope: TaskEnvelope = {
        step_id: "s1",
        worker: "jobhunt",
        objective: "Query job applications state",
        inputs: {},
        expected: { kind: "data", schema_ref: "data.generic" },
        constraints: dummyConstraints,
      };
      const badResult = await VERIFIERS["jobhunt"]!.verify({ rows: [{ id: "1" }] }, envelope);
      expect(badResult.ok).toBe(false);
      expect(badResult.error).toContain("missing explicit count field");

      const goodResult = await VERIFIERS["jobhunt"]!.verify({ count: 1, total: 10, rows: [{ id: "1" }] }, envelope);
      expect(goodResult.ok).toBe(true);
    });

    it("engineering verifier rejects failed command execution output", async () => {
      const envelope: TaskEnvelope = {
        step_id: "s1",
        worker: "engineering",
        objective: "Execute code build command",
        inputs: {},
        expected: { kind: "action_receipt", schema_ref: "action.summary" },
        constraints: dummyConstraints,
      };
      const badResult = await VERIFIERS["engineering"]!.verify("Command failed with exit code 1", envelope);
      expect(badResult.ok).toBe(false);
      expect(badResult.error).toContain("command failure");
    });

    it("research verifier rejects claims without source URLs", async () => {
      const envelope: TaskEnvelope = {
        step_id: "s1",
        worker: "research",
        objective: "Perform web research on target company",
        inputs: {},
        expected: { kind: "data", schema_ref: "research.findings" },
        constraints: dummyConstraints,
      };
      const badResult = await VERIFIERS["research"]!.verify(
        { summary: "Detailed research findings claiming market insights and industry data without sources.", sources: [] },
        envelope,
      );
      expect(badResult.ok).toBe(false);
      expect(badResult.error).toContain("zero source URLs");
    });
  });

  describe("missionSatisfied Check", () => {
    it("returns ok: true when all steps pass and requirements met", () => {
      const goal = "Summarize recent job applications";
      const steps: TaskEnvelope[] = [
        {
          step_id: "s1",
          worker: "jobhunt",
          objective: "Query job applications state",
          inputs: {},
          expected: { kind: "data", schema_ref: "data.generic" },
          constraints: dummyConstraints,
        },
      ];
      const results: StepResult[] = [
        { status: "ok", step_id: "s1", output: { count: 5, total: 5 }, tool_receipts: [] },
      ];
      const res = missionSatisfied(goal, steps, results);
      expect(res.ok).toBe(true);
    });

    it("detects 3-of-39 records partial delivery for 'all jobs' goal", () => {
      const goal = "Export all jobs into a CSV file";
      const steps: TaskEnvelope[] = [
        {
          step_id: "s1",
          worker: "jobhunt",
          objective: "Query job applications state",
          inputs: {},
          expected: { kind: "data", schema_ref: "data.generic" },
          constraints: dummyConstraints,
        },
      ];
      const results: StepResult[] = [
        {
          status: "ok",
          step_id: "s1",
          output: { count: 3, total: 39 },
          tool_receipts: [],
          observed: { kind: "record", evidence: "count:3,total:39" },
        },
      ];
      const res = missionSatisfied(goal, steps, results);
      expect(res.ok).toBe(false);
      expect(res.unmet).toBeDefined();
      expect(res.unmet![0]).toContain("delivered 3 of 39 total records");
    });

    it("detects missing delivery when delivery is requested in goal", () => {
      const goal = "Export all jobs and send me the file on Telegram";
      const steps: TaskEnvelope[] = [
        {
          step_id: "s1",
          worker: "jobhunt",
          objective: "Query job applications state",
          inputs: {},
          expected: { kind: "data", schema_ref: "data.generic" },
          constraints: dummyConstraints,
        },
      ];
      const results: StepResult[] = [
        {
          status: "ok",
          step_id: "s1",
          output: { count: 39, total: 39 },
          tool_receipts: [],
          observed: { kind: "record", evidence: "count:39,total:39" },
        },
      ];
      const res = missionSatisfied(goal, steps, results);
      expect(res.ok).toBe(false);
      expect(res.unmet![0]).toContain("no file delivery attachment step succeeded");
    });
  });
});
