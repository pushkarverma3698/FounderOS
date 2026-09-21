/**
 * Worker Contract — validation, required fields, versioning.
 */
import { describe, test, expect } from "vitest";
import { parseWorkerContract, validateWorkerContract } from "../../../src/workers/contracts/validation.js";
import { CAREER_OPERATOR_CONTRACT } from "../../../src/workers/contracts/career-operator.js";
import type { WorkerContract } from "../../../src/workers/contracts/types.js";

describe("WorkerContract validation", () => {
  test("career operator fixture passes validation", () => {
    const result = validateWorkerContract(CAREER_OPERATOR_CONTRACT);
    expect(result.ok).toBe(true);
  });

  test("parses a valid raw contract object", () => {
    const raw = {
      worker: { id: "test_worker", name: "Test Worker", contractVersion: "1.0.0" },
      identity: { represents: "Test", role: "Tester" },
      purpose: "Run tests.",
      responsibilities: ["test things"],
      capabilities: ["test.run"],
      runtime: { provider: "stub" },
    };
    const result = parseWorkerContract(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.contract.worker.id).toBe("test_worker");
      expect(result.contract.lifecycle.status).toBe("CREATED");
      expect(result.contract.permissions.allowed).toEqual([]);
      expect(result.contract.schedule.mode).toBe("on_demand");
    }
  });

  test("rejects missing worker.id", () => {
    const raw = {
      worker: { name: "No ID", contractVersion: "1.0.0" },
      identity: { represents: "Test", role: "Tester" },
      purpose: "Test.",
      responsibilities: ["test"],
      capabilities: ["test.run"],
      runtime: { provider: "stub" },
    };
    const result = parseWorkerContract(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.includes("worker.id"))).toBe(true);
  });

  test("rejects invalid worker.id format (must be lowercase with underscores)", () => {
    const raw = {
      worker: { id: "Invalid-ID", name: "Bad", contractVersion: "1.0.0" },
      identity: { represents: "Test", role: "Tester" },
      purpose: "Test.",
      responsibilities: ["test"],
      capabilities: ["test.run"],
      runtime: { provider: "stub" },
    };
    const result = parseWorkerContract(raw);
    expect(result.ok).toBe(false);
  });

  test("rejects invalid contractVersion format (must be semver)", () => {
    const raw = {
      worker: { id: "test_worker", name: "Bad", contractVersion: "v1" },
      identity: { represents: "Test", role: "Tester" },
      purpose: "Test.",
      responsibilities: ["test"],
      capabilities: ["test.run"],
      runtime: { provider: "stub" },
    };
    const result = parseWorkerContract(raw);
    expect(result.ok).toBe(false);
  });

  test("rejects empty responsibilities", () => {
    const raw = {
      worker: { id: "test_worker", name: "Bad", contractVersion: "1.0.0" },
      identity: { represents: "Test", role: "Tester" },
      purpose: "Test.",
      responsibilities: [],
      capabilities: ["test.run"],
      runtime: { provider: "stub" },
    };
    const result = parseWorkerContract(raw);
    expect(result.ok).toBe(false);
  });

  test("rejects empty capabilities", () => {
    const raw = {
      worker: { id: "test_worker", name: "Bad", contractVersion: "1.0.0" },
      identity: { represents: "Test", role: "Tester" },
      purpose: "Test.",
      responsibilities: ["test"],
      capabilities: [],
      runtime: { provider: "stub" },
    };
    const result = parseWorkerContract(raw);
    expect(result.ok).toBe(false);
  });

  test("rejects missing runtime.provider", () => {
    const raw = {
      worker: { id: "test_worker", name: "Bad", contractVersion: "1.0.0" },
      identity: { represents: "Test", role: "Tester" },
      purpose: "Test.",
      responsibilities: ["test"],
      capabilities: ["test.run"],
      runtime: {},
    };
    const result = parseWorkerContract(raw);
    expect(result.ok).toBe(false);
  });

  test("preserves objectives with priority", () => {
    const raw = {
      worker: { id: "test_worker", name: "Test", contractVersion: "1.0.0" },
      identity: { represents: "Test", role: "Tester" },
      purpose: "Test.",
      responsibilities: ["test"],
      capabilities: ["test.run"],
      runtime: { provider: "stub" },
      objectives: [
        { id: "obj_1", description: "First objective", priority: "critical" },
        { id: "obj_2", description: "Second objective" },
      ],
    };
    const result = parseWorkerContract(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.contract.objectives).toHaveLength(2);
      expect(result.contract.objectives[0]?.priority).toBe("critical");
      expect(result.contract.objectives[1]?.priority).toBe("normal");
    }
  });

  test("career operator contract has correct structure", () => {
    const c = CAREER_OPERATOR_CONTRACT;
    expect(c.worker.id).toBe("career_operator");
    expect(c.identity.represents).toBe("Pushkar");
    expect(c.responsibilities.length).toBeGreaterThan(0);
    expect(c.capabilities.length).toBeGreaterThan(0);
    expect(c.constraints.length).toBeGreaterThan(0);
    expect(c.permissions.allowed.length).toBeGreaterThan(0);
    expect(c.permissions.approvalRequired.length).toBeGreaterThan(0);
    expect(c.context.memoryScopes.length).toBeGreaterThan(0);
  });
});
