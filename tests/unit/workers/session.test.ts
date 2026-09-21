import { describe, test, expect, vi } from "vitest";
import { WorkerRuntimeSession, WorkerSessionManager } from "../../../src/workers/runtime/session.js";

describe("WorkerRuntimeSession & WorkerSessionManager", () => {
  test("creates an active session with default metadata and persist=false", async () => {
    const session = new WorkerRuntimeSession({
      workerId: "test_worker",
      runtimeProvider: "stub_runtime",
      persist: false,
    });

    expect(session.sessionId).toMatch(/^sess_test_worker_/);
    expect(session.workerId).toBe("test_worker");
    expect(session.runtimeProvider).toBe("stub_runtime");
    expect(session.status).toBe("active");
    expect(session.startedAt).toBeInstanceOf(Date);
    expect(session.lastHeartbeat).toBeInstanceOf(Date);
  });

  test("heartbeat updates lastHeartbeat timestamp", async () => {
    const session = new WorkerRuntimeSession({
      workerId: "test_worker",
      runtimeProvider: "stub_runtime",
      persist: false,
    });

    const initial = session.lastHeartbeat.getTime();
    await new Promise((r) => setTimeout(r, 10));
    await session.heartbeat();

    expect(session.lastHeartbeat.getTime()).toBeGreaterThanOrEqual(initial);
  });

  test("updateMetadata merges metadata patches", async () => {
    const session = new WorkerRuntimeSession({
      workerId: "test_worker",
      runtimeProvider: "stub_runtime",
      metadata: { initial: 1 },
      persist: false,
    });

    await session.updateMetadata({ step: 2, currentTask: "task-1" });

    expect(session.metadata).toEqual({
      initial: 1,
      step: 2,
      currentTask: "task-1",
    });
  });

  test("end transitions status and records exit reason", async () => {
    const session = new WorkerRuntimeSession({
      workerId: "test_worker",
      runtimeProvider: "stub_runtime",
      persist: false,
    });

    await session.end("completed", "All tasks done");

    expect(session.status).toBe("completed");
    expect(session.metadata["exitReason"]).toBe("All tasks done");
  });

  test("WorkerSessionManager manages sessions and closes previous ones", async () => {
    const manager = new WorkerSessionManager();

    const sess1 = await manager.createSession("worker_1", "stub_runtime", {}, false);
    expect(sess1.status).toBe("active");

    const retrieved = await manager.getSession("worker_1", false);
    expect(retrieved?.sessionId).toBe(sess1.sessionId);

    // Creating a second session closes the first
    const sess2 = await manager.createSession("worker_1", "stub_runtime", {}, false);
    expect(sess1.status).toBe("terminated");
    expect(sess2.status).toBe("active");

    const retrieved2 = await manager.getSession("worker_1", false);
    expect(retrieved2?.sessionId).toBe(sess2.sessionId);

    await manager.closeSession("worker_1", "completed", "Done");
    expect(sess2.status).toBe("completed");

    const retrieved3 = await manager.getSession("worker_1", false);
    expect(retrieved3).toBeNull();
  });

  test("WorkerSessionManager sweeps stale sessions", async () => {
    const manager = new WorkerSessionManager();
    const session = await manager.createSession("worker_stale", "stub_runtime", {}, false);

    // Artificially age the heartbeat
    session.lastHeartbeat = new Date(Date.now() - 10000);

    const staleIds = await manager.sweepStaleSessions(5000); // 5s threshold
    expect(staleIds).toContain("worker_stale");
    expect(session.status).toBe("failed");

    const active = await manager.getSession("worker_stale", false);
    expect(active).toBeNull();
  });
});
