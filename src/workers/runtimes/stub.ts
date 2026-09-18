/**
 * FounderOS — Stub Runtime Adapter
 * ==================================
 * Minimal runtime adapter for testing the contract → lifecycle → runtime flow
 * without requiring any real runtime (Antigravity, Claude Code, OpenClaw).
 *
 * Logs lifecycle transitions. Does not execute tools or perform side effects.
 * Tests inject this adapter to verify the full bootstrap/lifecycle pipeline.
 */

import { randomUUID } from "node:crypto";
import type {
  WorkerRuntimeAdapter,
  WorkerRuntimeHandle,
  WorkerRuntimeStatus,
  RuntimeBootstrapPacket,
  WorkerTask,
} from "./types.js";
import type { WorkerContract } from "../contracts/types.js";

export class StubRuntimeAdapter implements WorkerRuntimeAdapter {
  readonly providerId = "stub";

  /** Log of all lifecycle events — tests inspect this. */
  readonly log: Array<{ event: string; workerId: string; timestamp: string; detail?: string }> = [];

  /** Active handles by workerId. */
  private handles = new Map<string, { handle: WorkerRuntimeHandle; state: WorkerRuntimeStatus["state"] }>();

  private emit(event: string, workerId: string, detail?: string): void {
    this.log.push({ event, workerId, timestamp: new Date().toISOString(), detail });
  }

  async start(contract: WorkerContract, bootstrap: RuntimeBootstrapPacket): Promise<WorkerRuntimeHandle> {
    const handle: WorkerRuntimeHandle = {
      workerId: contract.worker.id,
      runtimeId: `stub-${randomUUID().slice(0, 8)}`,
      providerId: this.providerId,
      startedAt: new Date().toISOString(),
    };
    this.handles.set(contract.worker.id, { handle, state: "running" });
    this.emit("start", contract.worker.id, `bootstrap: ${bootstrap.toolManifest.tools.length} tools`);
    return handle;
  }

  async sendTask(handle: WorkerRuntimeHandle, task: WorkerTask): Promise<void> {
    this.emit("task", handle.workerId, `task: ${task.taskId} — ${task.description}`);
  }

  async getStatus(handle: WorkerRuntimeHandle): Promise<WorkerRuntimeStatus> {
    const entry = this.handles.get(handle.workerId);
    return {
      workerId: handle.workerId,
      runtimeId: handle.runtimeId,
      state: entry?.state ?? "stopped",
    };
  }

  async stop(handle: WorkerRuntimeHandle): Promise<void> {
    const entry = this.handles.get(handle.workerId);
    if (entry) entry.state = "stopped";
    this.emit("stop", handle.workerId);
  }

  async pause(handle: WorkerRuntimeHandle): Promise<void> {
    const entry = this.handles.get(handle.workerId);
    if (entry) entry.state = "idle";
    this.emit("pause", handle.workerId);
  }

  async resume(handle: WorkerRuntimeHandle): Promise<void> {
    const entry = this.handles.get(handle.workerId);
    if (entry) entry.state = "running";
    this.emit("resume", handle.workerId);
  }
}
