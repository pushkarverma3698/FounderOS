/**
 * Worker Lifecycle Manager — state transitions, validation, failure handling.
 */
import { describe, test, expect, beforeEach } from "vitest";
import { WorkerLifecycleManager } from "../../../src/workers/lifecycle/manager.js";
import { CAREER_OPERATOR_CONTRACT } from "../../../src/workers/contracts/career-operator.js";
import type { WorkerContract } from "../../../src/workers/contracts/types.js";

const minimalContract: WorkerContract = {
  worker: { id: "test_worker", name: "Test", contractVersion: "1.0.0" },
  identity: { represents: "Test", role: "Tester" },
  purpose: "Test.",
  responsibilities: ["test"],
  objectives: [],
  constraints: [],
  capabilities: ["test.run"],
  permissions: { allowed: [], approvalRequired: [], denied: [] },
  context: { memoryScopes: [], contextRefs: [] },
  runtime: { provider: "stub" },
  schedule: { mode: "on_demand" },
  lifecycle: { status: "CREATED" },
};

describe("WorkerLifecycleManager", () => {
  let lm: WorkerLifecycleManager;

  beforeEach(() => {
    lm = new WorkerLifecycleManager();
  });

  test("create sets status to CREATED", () => {
    const state = lm.create(minimalContract);
    expect(state.status).toBe("CREATED");
    expect(state.workerId).toBe("test_worker");
    expect(state.contractVersion).toBe("1.0.0");
  });

  test("full happy path: CREATED → CONFIGURED → READY → RUNNING → STOPPED", () => {
    lm.create(minimalContract);
    expect(lm.configure("test_worker").status).toBe("CONFIGURED");
    expect(lm.ready("test_worker").status).toBe("READY");
    expect(lm.start("test_worker").status).toBe("RUNNING");
    expect(lm.stop("test_worker").status).toBe("STOPPED");
  });

  test("RUNNING → PAUSED → READY → RUNNING", () => {
    lm.create(minimalContract);
    lm.configure("test_worker");
    lm.ready("test_worker");
    lm.start("test_worker");
    expect(lm.pause("test_worker").status).toBe("PAUSED");
    expect(lm.ready("test_worker").status).toBe("READY");
    expect(lm.start("test_worker").status).toBe("RUNNING");
  });

  test("RUNNING → WAITING → RUNNING", () => {
    lm.create(minimalContract);
    lm.configure("test_worker");
    lm.ready("test_worker");
    lm.start("test_worker");
    expect(lm.wait("test_worker").status).toBe("WAITING");
    expect(lm.start("test_worker").status).toBe("RUNNING");
  });

  test("RUNNING → BLOCKED → READY", () => {
    lm.create(minimalContract);
    lm.configure("test_worker");
    lm.ready("test_worker");
    lm.start("test_worker");
    expect(lm.block("test_worker").status).toBe("BLOCKED");
    expect(lm.ready("test_worker").status).toBe("READY");
  });

  test("fail() records reason", () => {
    lm.create(minimalContract);
    lm.configure("test_worker");
    lm.ready("test_worker");
    lm.start("test_worker");
    const state = lm.fail("test_worker", "runtime crashed");
    expect(state.status).toBe("FAILED");
    expect(state.failureReason).toBe("runtime crashed");
  });

  test("re-create from FAILED", () => {
    lm.create(minimalContract);
    lm.configure("test_worker");
    lm.fail("test_worker", "crashed");
    const state = lm.create(minimalContract);
    expect(state.status).toBe("CREATED");
    expect(state.failureReason).toBeUndefined();
  });

  test("re-create from STOPPED", () => {
    lm.create(minimalContract);
    lm.configure("test_worker");
    lm.ready("test_worker");
    lm.stop("test_worker");
    const state = lm.create(minimalContract);
    expect(state.status).toBe("CREATED");
  });

  test("rejects invalid transition: CREATED → RUNNING", () => {
    lm.create(minimalContract);
    expect(() => lm.start("test_worker")).toThrow(/Invalid transition/);
  });

  test("rejects invalid transition: STOPPED → RUNNING", () => {
    lm.create(minimalContract);
    lm.configure("test_worker");
    lm.ready("test_worker");
    lm.stop("test_worker");
    expect(() => lm.start("test_worker")).toThrow(/Invalid transition/);
  });

  test("rejects double-create for active worker", () => {
    lm.create(minimalContract);
    lm.configure("test_worker");
    expect(() => lm.create(minimalContract)).toThrow(/already exists/);
  });

  test("rejects transition for unknown worker", () => {
    expect(() => lm.start("nonexistent")).toThrow(/not found/);
  });

  test("getState returns undefined for unknown worker", () => {
    expect(lm.getState("nonexistent")).toBeUndefined();
  });

  test("getState returns a copy (not a reference)", () => {
    lm.create(minimalContract);
    const s1 = lm.getState("test_worker")!;
    const s2 = lm.getState("test_worker")!;
    expect(s1).toEqual(s2);
    expect(s1).not.toBe(s2);
  });

  test("listWorkers returns all tracked workers", () => {
    lm.create(minimalContract);
    lm.create({ ...minimalContract, worker: { ...minimalContract.worker, id: "other_worker" } });
    expect(lm.listWorkers()).toHaveLength(2);
  });

  test("works with career operator contract", () => {
    const state = lm.create(CAREER_OPERATOR_CONTRACT);
    expect(state.workerId).toBe("career_operator");
    expect(state.contractVersion).toBe("1.0.0");
  });
});
