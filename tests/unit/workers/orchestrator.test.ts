import { describe, test, expect } from "vitest";
import { WorkerRuntimeOrchestrator } from "../../../src/workers/runtime/orchestrator.js";
import { StubRuntimeAdapter } from "../../../src/workers/runtimes/stub.js";
import { CAREER_OPERATOR_CONTRACT } from "../../../src/workers/contracts/career-operator.js";
import { initializeToolRegistry } from "../../../src/tools/registry/init.js";

describe("WorkerRuntimeOrchestrator", () => {
  test("full lifecycle: register, start, pause, resume, sleep, wake, dispatch, stop", async () => {
    initializeToolRegistry();

    const orchestrator = new WorkerRuntimeOrchestrator();
    const adapter = new StubRuntimeAdapter();

    // 1. Register contract (in-memory mode for test)
    await orchestrator.registerContract(CAREER_OPERATOR_CONTRACT, false);

    // 2. Start worker
    const handle = await orchestrator.startWorker("career_operator", adapter, {
      missionId: "mission-123",
      persist: false,
    });

    expect(handle.workerId).toBe("career_operator");
    expect(handle.providerId).toBe("stub");

    let state = orchestrator.getState("career_operator");
    expect(state?.status).toBe("RUNNING");

    let session = await orchestrator.getSession("career_operator");
    expect(session?.status).toBe("active");

    // Adapter should have recorded start
    const status = await adapter.getStatus(handle);
    expect(status.state).toBe("running");

    // 3. Dispatch task
    await orchestrator.dispatchTask("career_operator", {
      taskId: "task-1",
      description: "Screen new opportunities",
    });
    const taskEvents = adapter.log.filter((e) => e.event === "task");
    expect(taskEvents).toHaveLength(1);
    expect(taskEvents[0]?.detail).toContain("task-1");

    // 4. Pause worker
    await orchestrator.pauseWorker("career_operator", "Lunch break", false);
    state = orchestrator.getState("career_operator");
    expect(state?.status).toBe("PAUSED");

    // 5. Resume worker
    await orchestrator.resumeWorker("career_operator", false);
    state = orchestrator.getState("career_operator");
    expect(state?.status).toBe("RUNNING");

    // 6. Sleep idle worker
    await orchestrator.sleepWorker("career_operator", false);
    state = orchestrator.getState("career_operator");
    expect(state?.status).toBe("WAITING");

    // 7. Wake sleeping worker
    await orchestrator.wakeWorker("career_operator", "cron_tick", false);
    state = orchestrator.getState("career_operator");
    expect(state?.status).toBe("RUNNING");

    // 8. Stop worker
    await orchestrator.stopWorker("career_operator", "End of day", false);
    state = orchestrator.getState("career_operator");
    expect(state?.status).toBe("STOPPED");

    const finalStatus = await adapter.getStatus(handle);
    expect(finalStatus.state).toBe("stopped");
  });

  test("rejects starting an unregistered worker", async () => {
    const orchestrator = new WorkerRuntimeOrchestrator();
    const adapter = new StubRuntimeAdapter();

    await expect(
      orchestrator.startWorker("non_existent_worker", adapter, { persist: false }),
    ).rejects.toThrow(/contract not found/);
  });

  test("rejects task dispatch when worker is not running", async () => {
    const orchestrator = new WorkerRuntimeOrchestrator();
    const adapter = new StubRuntimeAdapter();
    await orchestrator.registerContract(CAREER_OPERATOR_CONTRACT, false);
    await orchestrator.startWorker("career_operator", adapter, { persist: false });
    await orchestrator.pauseWorker("career_operator", "Hold", false);

    await expect(
      orchestrator.dispatchTask("career_operator", {
        taskId: "task-2",
        description: "Do something",
      }),
    ).rejects.toThrow(/is in state "PAUSED", cannot receive tasks/);
  });
});
