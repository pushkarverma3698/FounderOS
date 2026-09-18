/**
 * FounderOS — Worker Runtime Adapter Interface
 * ===============================================
 * Runtime-independent interface for executing workers. The adapter bridges
 * the gap between FounderOS control plane and the actual runtime environment.
 *
 * FounderOS → WorkerRuntimeAdapter → Runtime (Antigravity, Claude Code, OpenClaw)
 *
 * Business logic NEVER lives inside a runtime adapter. The adapter's job is:
 * - start/stop/pause/resume the runtime
 * - deliver the bootstrap packet
 * - forward tasks and collect progress
 *
 * Durable state (contracts, objectives, approvals) stays in FounderOS.
 * The runtime owns only temporary working context.
 */

import type { WorkerContract, WorkerObjective, WorkerPermissions } from "../contracts/types.js";
import type { WorkerToolManifest } from "../capabilities/manifest.js";
import type { WorkerIdentity } from "../contracts/types.js";

// ── Bootstrap packet ─────────────────────────────────────────────────────────

/** Portable payload delivered to the runtime at worker start. Contains
 *  everything the runtime needs to begin executing — no database access required.
 *  Large memory is NOT included; only references the runtime can use for retrieval. */
export interface RuntimeBootstrapPacket {
  workerId: string;
  contractVersion: string;
  identity: WorkerIdentity;
  purpose: string;
  responsibilities: string[];
  objectives: WorkerObjective[];
  constraints: string[];
  permissions: WorkerPermissions;
  toolManifest: WorkerToolManifest;
  contextRefs: string[];
  missionId?: string;
}

// ── Task payload ─────────────────────────────────────────────────────────────

/** A task dispatched to a running worker. Dynamic — not part of the contract. */
export interface WorkerTask {
  taskId: string;
  description: string;
  /** Optional link to the mission/objective this task serves. */
  objectiveId?: string;
  missionId?: string;
  /** Arbitrary structured input the runtime may need. */
  input?: Record<string, unknown>;
}

// ── Runtime handle ───────────────────────────────────────────────────────────

/** Opaque handle returned by start(). Runtime adapters define the internals. */
export interface WorkerRuntimeHandle {
  workerId: string;
  runtimeId: string;
  providerId: string;
  startedAt: string;
}

// ── Runtime status ───────────────────────────────────────────────────────────

export interface WorkerRuntimeStatus {
  workerId: string;
  runtimeId: string;
  state: "running" | "idle" | "stopped" | "errored";
  lastActivity?: string;
  error?: string;
}

// ── Adapter interface ────────────────────────────────────────────────────────

export interface WorkerRuntimeAdapter {
  /** Unique identifier for this runtime provider (e.g. "antigravity", "claude_code"). */
  readonly providerId: string;

  /** Start a worker with the given contract and bootstrap payload. */
  start(contract: WorkerContract, bootstrap: RuntimeBootstrapPacket): Promise<WorkerRuntimeHandle>;

  /** Dispatch a task to a running worker. */
  sendTask(handle: WorkerRuntimeHandle, task: WorkerTask): Promise<void>;

  /** Query the current runtime status of a worker. */
  getStatus(handle: WorkerRuntimeHandle): Promise<WorkerRuntimeStatus>;

  /** Gracefully stop a running worker. */
  stop(handle: WorkerRuntimeHandle): Promise<void>;

  /** Pause a running worker (preserving state for resume). */
  pause(handle: WorkerRuntimeHandle): Promise<void>;

  /** Resume a paused worker. */
  resume(handle: WorkerRuntimeHandle): Promise<void>;
}
