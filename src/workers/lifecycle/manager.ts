/**
 * FounderOS — Worker Lifecycle Manager
 * =======================================
 * Manages worker lifecycle state transitions and enforces the valid transition
 * graph defined in contracts/types.ts.
 *
 * State is held in-memory for this milestone. A Postgres-backed implementation
 * will persist to the worker_state table when migrated.
 *
 * If a runtime crashes, FounderOS can reconstruct the worker from:
 * - the durable contract (identity, capabilities, permissions)
 * - the lifecycle state (last known status)
 * - durable business state (objectives, tasks, memories)
 *
 * The new runtime continues from the last persisted state.
 */

import {
  type WorkerStatus,
  type WorkerContract,
  VALID_TRANSITIONS,
} from "../contracts/types.js";

// ── Worker state ─────────────────────────────────────────────────────────────

export interface WorkerState {
  workerId: string;
  status: WorkerStatus;
  contractVersion: string;
  lastTransition: string;
  failureReason?: string;
}

// ── Lifecycle manager ────────────────────────────────────────────────────────

export class WorkerLifecycleManager {
  private states = new Map<string, WorkerState>();

  /** Create a worker from a contract. Sets status to CREATED. */
  create(contract: WorkerContract): WorkerState {
    if (this.states.has(contract.worker.id)) {
      const existing = this.states.get(contract.worker.id)!;
      // Allow re-creation only from terminal states
      if (existing.status !== "STOPPED" && existing.status !== "FAILED") {
        throw new Error(
          `Worker "${contract.worker.id}" already exists in status ${existing.status}. ` +
          `Stop or fail it before re-creating.`,
        );
      }
    }

    const state: WorkerState = {
      workerId: contract.worker.id,
      status: "CREATED",
      contractVersion: contract.worker.contractVersion,
      lastTransition: new Date().toISOString(),
    };
    this.states.set(contract.worker.id, state);
    return { ...state };
  }

  /** Transition a worker to CONFIGURED. */
  configure(workerId: string): WorkerState {
    return this.transition(workerId, "CONFIGURED");
  }

  /** Transition a worker to READY. */
  ready(workerId: string): WorkerState {
    return this.transition(workerId, "READY");
  }

  /** Transition a worker to RUNNING. */
  start(workerId: string): WorkerState {
    return this.transition(workerId, "RUNNING");
  }

  /** Transition a worker to WAITING. */
  wait(workerId: string): WorkerState {
    return this.transition(workerId, "WAITING");
  }

  /** Transition a worker to PAUSED. */
  pause(workerId: string): WorkerState {
    return this.transition(workerId, "PAUSED");
  }

  /** Transition a worker to BLOCKED. */
  block(workerId: string): WorkerState {
    return this.transition(workerId, "BLOCKED");
  }

  /** Transition a worker to STOPPED. */
  stop(workerId: string): WorkerState {
    return this.transition(workerId, "STOPPED");
  }

  /** Transition a worker to FAILED with a reason. */
  fail(workerId: string, reason: string): WorkerState {
    const state = this.transition(workerId, "FAILED");
    state.failureReason = reason;
    const stored = this.states.get(workerId);
    if (stored) stored.failureReason = reason;
    return state;
  }

  /** Get current state. Returns undefined if worker was never created. */
  getState(workerId: string): WorkerState | undefined {
    const state = this.states.get(workerId);
    return state ? { ...state } : undefined;
  }

  /** List all tracked workers. */
  listWorkers(): WorkerState[] {
    return [...this.states.values()].map((s) => ({ ...s }));
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private transition(workerId: string, target: WorkerStatus): WorkerState {
    const current = this.states.get(workerId);
    if (!current) {
      throw new Error(`Worker "${workerId}" not found. Call create() first.`);
    }

    const allowed = VALID_TRANSITIONS[current.status];
    if (!allowed.includes(target)) {
      throw new Error(
        `Invalid transition: ${current.status} → ${target} for worker "${workerId}". ` +
        `Allowed from ${current.status}: ${allowed.join(", ") || "(none)"}`,
      );
    }

    current.status = target;
    current.lastTransition = new Date().toISOString();
    if (target !== "FAILED") {
      delete current.failureReason;
    }

    return { ...current };
  }
}
