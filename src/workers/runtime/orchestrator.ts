/**
 * FounderOS — Worker Runtime Orchestrator
 * =========================================
 * Coordinates worker contracts, lifecycle states, runtime adapters,
 * active execution sessions, and durable database persistence.
 */

import { WorkerLifecycleManager, type WorkerState } from "../lifecycle/manager.js";
import { WorkerSessionManager, type WorkerRuntimeSession } from "./session.js";
import { CapabilityResolver } from "../capabilities/resolver.js";
import { DEFAULT_CAPABILITY_MAPPINGS } from "../capabilities/mappings.js";
import { buildWorkerToolManifest } from "../capabilities/manifest.js";
import { toolRegistry as globalToolRegistry, type ToolRegistry } from "../../tools/registry/registry.js";
import type {
  WorkerContract,
  WorkerStatus,
} from "../contracts/types.js";
import type {
  WorkerRuntimeAdapter,
  WorkerRuntimeHandle,
  WorkerTask,
  RuntimeBootstrapPacket,
} from "../runtimes/types.js";
import type { WorkerProgressReport } from "../lifecycle/progress.js";
import {
  upsertWorkerContract,
  getWorkerContract,
  updateWorkerState,
  getWorkerState,
  recordWorkerProgress,
} from "../db/queries.js";

interface ActiveWorkerEntry {
  handle: WorkerRuntimeHandle;
  adapter: WorkerRuntimeAdapter;
  contract: WorkerContract;
}

export class WorkerRuntimeOrchestrator {
  private lifecycleManager = new WorkerLifecycleManager();
  private sessionManager = new WorkerSessionManager();
  private capabilityResolver: CapabilityResolver;
  private toolRegistry: ToolRegistry;
  private contracts = new Map<string, WorkerContract>();
  private activeWorkers = new Map<string, ActiveWorkerEntry>();

  constructor(options?: {
    capabilityResolver?: CapabilityResolver;
    toolRegistry?: ToolRegistry;
  }) {
    if (options?.capabilityResolver) {
      this.capabilityResolver = options.capabilityResolver;
    } else {
      this.capabilityResolver = new CapabilityResolver();
      this.capabilityResolver.registerMappings(DEFAULT_CAPABILITY_MAPPINGS);
    }
    this.toolRegistry = options?.toolRegistry ?? globalToolRegistry;
  }

  /**
   * Register a contract in-memory and optionally persist it to the database.
   */
  async registerContract(contract: WorkerContract, persist: boolean = true): Promise<void> {
    const workerId = contract.worker.id;
    this.contracts.set(workerId, contract);

    if (persist) {
      try {
        await upsertWorkerContract(contract);
      } catch {
        // Fallback: keep in memory if database is disconnected
      }
    }
  }

  /**
   * Get a registered contract from memory or database.
   */
  async getContract(workerId: string): Promise<WorkerContract | null> {
    const mem = this.contracts.get(workerId);
    if (mem) return mem;

    try {
      const dbContract = await getWorkerContract(workerId);
      if (dbContract) {
        this.contracts.set(workerId, dbContract);
        return dbContract;
      }
    } catch {
      // Ignore DB error
    }

    return null;
  }

  /**
   * Start a worker:
   * 1. Loads contract
   * 2. Runs lifecycle transitions CREATED -> CONFIGURED -> READY -> RUNNING
   * 3. Resolves capabilities to scoped tool manifest
   * 4. Initializes runtime adapter
   * 5. Tracks execution session & persists state
   */
  async startWorker(
    workerId: string,
    adapter: WorkerRuntimeAdapter,
    options?: {
      missionId?: string;
      persist?: boolean;
    },
  ): Promise<WorkerRuntimeHandle> {
    const contract = await this.getContract(workerId);
    if (!contract) {
      throw new Error(`Cannot start worker "${workerId}": contract not found.`);
    }

    const persist = options?.persist ?? true;

    // 1. Lifecycle state transitions
    let currentState = this.lifecycleManager.getState(workerId);
    if (!currentState || currentState.status === "STOPPED" || currentState.status === "FAILED") {
      this.lifecycleManager.create(contract);
      this.lifecycleManager.configure(workerId);
      this.lifecycleManager.ready(workerId);
    } else if (currentState.status === "PAUSED" || currentState.status === "BLOCKED") {
      this.lifecycleManager.ready(workerId);
    } else if (currentState.status === "WAITING") {
      // Waking from sleep
    }

    this.lifecycleManager.start(workerId);

    // 2. Resolve capability manifest
    const manifest = buildWorkerToolManifest(contract, this.toolRegistry, this.capabilityResolver);

    // 3. Build bootstrap packet
    const bootstrap: RuntimeBootstrapPacket = {
      workerId: contract.worker.id,
      contractVersion: contract.worker.contractVersion,
      identity: contract.identity,
      purpose: contract.purpose,
      responsibilities: contract.responsibilities,
      objectives: contract.objectives,
      constraints: contract.constraints,
      permissions: contract.permissions,
      toolManifest: manifest,
      contextRefs: contract.context.contextRefs,
      missionId: options?.missionId,
    };

    // 4. Start runtime adapter
    const handle = await adapter.start(contract, bootstrap);

    // 5. Create runtime session
    await this.sessionManager.createSession(
      workerId,
      adapter.providerId,
      {
        missionId: options?.missionId,
        runtimeId: handle.runtimeId,
      },
      persist,
    );

    // 6. Persist state in database
    if (persist) {
      try {
        await updateWorkerState(workerId, {
          status: "RUNNING",
          contractVersion: contract.worker.contractVersion,
          runtimeProvider: adapter.providerId,
          runtimeId: handle.runtimeId,
          failureReason: null,
        });
      } catch {
        // Fallback: in-memory state is already maintained
      }
    }

    this.activeWorkers.set(workerId, { handle, adapter, contract });
    return handle;
  }

  /**
   * Pause a running worker.
   */
  async pauseWorker(workerId: string, reason?: string, persist: boolean = true): Promise<void> {
    const entry = this.activeWorkers.get(workerId);
    if (!entry) {
      throw new Error(`Cannot pause worker "${workerId}": not actively running.`);
    }

    this.lifecycleManager.pause(workerId);
    await entry.adapter.pause(entry.handle);

    const session = await this.sessionManager.getSession(workerId, false);
    if (session) {
      session.status = "paused";
      if (reason) await session.updateMetadata({ pauseReason: reason });
    }

    if (persist) {
      try {
        await updateWorkerState(workerId, {
          status: "PAUSED",
          failureReason: reason ?? null,
        });
      } catch {
        // Non-fatal
      }
    }
  }

  /**
   * Resume a paused worker.
   */
  async resumeWorker(workerId: string, persist: boolean = true): Promise<void> {
    const entry = this.activeWorkers.get(workerId);
    if (!entry) {
      throw new Error(`Cannot resume worker "${workerId}": not found in active registry.`);
    }

    this.lifecycleManager.ready(workerId);
    this.lifecycleManager.start(workerId);

    await entry.adapter.resume(entry.handle);

    const session = await this.sessionManager.getSession(workerId, false);
    if (session) {
      session.status = "active";
    }

    if (persist) {
      try {
        await updateWorkerState(workerId, {
          status: "RUNNING",
          failureReason: null,
        });
      } catch {
        // Non-fatal
      }
    }
  }

  /**
   * Stop a worker cleanly.
   */
  async stopWorker(workerId: string, reason?: string, persist: boolean = true): Promise<void> {
    const entry = this.activeWorkers.get(workerId);
    if (entry) {
      await entry.adapter.stop(entry.handle);
      this.activeWorkers.delete(workerId);
    }

    this.lifecycleManager.stop(workerId);
    await this.sessionManager.closeSession(workerId, "completed", reason);

    if (persist) {
      try {
        await updateWorkerState(workerId, {
          status: "STOPPED",
          runtimeId: null,
          failureReason: reason ?? null,
        });
      } catch {
        // Non-fatal
      }
    }
  }

  /**
   * Sleep an idle worker (RUNNING -> WAITING).
   */
  async sleepWorker(workerId: string, persist: boolean = true): Promise<void> {
    this.lifecycleManager.wait(workerId);

    const session = await this.sessionManager.getSession(workerId, false);
    if (session) {
      await session.updateMetadata({ sleeping: true });
    }

    if (persist) {
      try {
        await updateWorkerState(workerId, {
          status: "WAITING",
        });
      } catch {
        // Non-fatal
      }
    }
  }

  /**
   * Wake a sleeping worker (WAITING -> RUNNING).
   */
  async wakeWorker(workerId: string, trigger?: string, persist: boolean = true): Promise<void> {
    this.lifecycleManager.start(workerId);

    const session = await this.sessionManager.getSession(workerId, false);
    if (session) {
      await session.updateMetadata({ sleeping: false, lastTrigger: trigger });
    }

    if (persist) {
      try {
        await updateWorkerState(workerId, {
          status: "RUNNING",
        });
      } catch {
        // Non-fatal
      }
    }
  }

  /**
   * Dispatch a task to an actively running worker.
   */
  async dispatchTask(workerId: string, task: WorkerTask): Promise<void> {
    const entry = this.activeWorkers.get(workerId);
    if (!entry) {
      throw new Error(`Cannot dispatch task to worker "${workerId}": worker is not running.`);
    }

    const state = this.lifecycleManager.getState(workerId);
    if (state?.status !== "RUNNING") {
      throw new Error(`Worker "${workerId}" is in state "${state?.status}", cannot receive tasks.`);
    }

    await entry.adapter.sendTask(entry.handle, task);
  }

  /**
   * Record a progress report for a worker.
   */
  async reportProgress(
    workerId: string,
    report: WorkerProgressReport,
    persist: boolean = true,
  ): Promise<void> {
    if (persist) {
      try {
        await recordWorkerProgress({
          workerId,
          status: report.status,
          summary: report.summary,
          missionId: report.missionId,
          taskId: report.taskId,
          blockers: report.blockers,
          nextAction: report.nextAction,
        });
      } catch {
        // Non-fatal
      }
    }
  }

  /**
   * Get current state of a worker.
   */
  getState(workerId: string): WorkerState | undefined {
    return this.lifecycleManager.getState(workerId);
  }

  /**
   * Get active session of a worker.
   */
  async getSession(workerId: string): Promise<WorkerRuntimeSession | null> {
    return await this.sessionManager.getSession(workerId);
  }

  /**
   * Expose session manager for administrative operations (sweeps, checks).
   */
  getSessionManager(): WorkerSessionManager {
    return this.sessionManager;
  }
}
