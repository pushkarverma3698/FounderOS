/**
 * FounderOS — Worker Context API
 * ================================
 * Interface for retrieving focused worker context from FounderOS durable state.
 *
 * Three context layers (documented in docs/architecture/worker-contracts.md):
 *
 * LAYER 1 — WORKER CONTRACT: Durable identity and authority.
 * LAYER 2 — WORKING CONTEXT: Current objective, task, recent state.
 * LAYER 3 — FOUNDEROS DURABLE STATE: Persistent memory, events, artifacts.
 *
 * The runtime owns Layer 2 (temporary working context).
 * FounderOS owns Layers 1 and 3 (durable truth).
 *
 * This module defines the interface and a default in-memory implementation.
 * The default implementation reads from worker contracts and registered state;
 * a Postgres-backed implementation can be wired when persistence is live.
 */

import type { WorkerContract, WorkerObjective, WorkerPermissions } from "../contracts/types.js";

// ── Context types ────────────────────────────────────────────────────────────

/** Focused context payload for a worker — never the full database. */
export interface WorkerContext {
  /** Worker identity from the contract. */
  workerId: string;
  workerName: string;
  role: string;
  purpose: string;

  /** Current objectives (from contract or dynamic assignment). */
  objectives: WorkerObjective[];

  /** Active responsibilities from the contract. */
  responsibilities: string[];

  /** Permissions snapshot. */
  permissions: WorkerPermissions;

  /** Constraints the worker must obey. */
  constraints: string[];

  /** Relevant memory scope identifiers the worker may query. */
  memoryScopes: string[];

  /** Opaque context references for runtime retrieval. */
  contextRefs: string[];

  /** Active mission ID, if the worker is currently assigned. */
  missionId?: string;
}

/** A memory entry retrieved from FounderOS durable state. */
export interface MemoryEntry {
  id: string;
  content: string;
  source: string;
  relevance?: number;
  timestamp?: string;
}

// ── Provider interface ───────────────────────────────────────────────────────

/**
 * Interface for retrieving worker context from FounderOS.
 *
 * Implementations may back this with Postgres, in-memory state, or a mix.
 * The runtime calls this interface — it never queries FounderOS tables directly.
 */
export interface WorkerContextProvider {
  /** Get focused context for a worker, optionally scoped to a mission. */
  getWorkerContext(workerId: string, missionId?: string): Promise<WorkerContext>;

  /** Get the worker's current objectives. */
  getActiveObjectives(workerId: string): Promise<WorkerObjective[]>;

  /** Search worker-scoped memories. Returns relevant entries, never the full store. */
  getRelevantMemories(workerId: string, query: string, limit?: number): Promise<MemoryEntry[]>;

  /** Get the worker's permission snapshot. */
  getWorkerPermissions(workerId: string): WorkerPermissions;
}

// ── Default implementation (contract-backed, in-memory) ──────────────────────

/**
 * Default WorkerContextProvider backed by registered contracts.
 *
 * This implementation reads from in-memory contract state. A Postgres-backed
 * implementation can extend or replace it when persistence tables are migrated.
 *
 * Memory retrieval returns an empty set — the real implementation will query
 * personal_rag / turicks_brain / brain_memories via existing search functions.
 */
export class DefaultWorkerContextProvider implements WorkerContextProvider {
  private contracts = new Map<string, WorkerContract>();

  /** Register a contract so context can be derived from it. */
  registerContract(contract: WorkerContract): void {
    this.contracts.set(contract.worker.id, contract);
  }

  async getWorkerContext(workerId: string, missionId?: string): Promise<WorkerContext> {
    const contract = this.contracts.get(workerId);
    if (!contract) {
      throw new Error(`Worker contract not found: ${workerId}`);
    }

    return {
      workerId: contract.worker.id,
      workerName: contract.worker.name,
      role: contract.identity.role,
      purpose: contract.purpose,
      objectives: contract.objectives,
      responsibilities: contract.responsibilities,
      permissions: contract.permissions,
      constraints: contract.constraints,
      memoryScopes: contract.context.memoryScopes,
      contextRefs: contract.context.contextRefs,
      ...(missionId ? { missionId } : {}),
    };
  }

  async getActiveObjectives(workerId: string): Promise<WorkerObjective[]> {
    const contract = this.contracts.get(workerId);
    return contract?.objectives ?? [];
  }

  async getRelevantMemories(_workerId: string, _query: string, _limit?: number): Promise<MemoryEntry[]> {
    // Stub: real implementation queries personal_rag / turicks_brain / brain_memories
    return [];
  }

  getWorkerPermissions(workerId: string): WorkerPermissions {
    const contract = this.contracts.get(workerId);
    return contract?.permissions ?? { allowed: [], approvalRequired: [], denied: [] };
  }
}
