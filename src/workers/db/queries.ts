/**
 * FounderOS — Worker Database Queries
 * =====================================
 * Named, typed query helpers for persistent digital workers.
 * All queries interact with tables in the `agents` schema via Drizzle ORM.
 */

import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../db/client.js";
import {
  workerContracts,
  workerState,
  workerSessions,
  workerObjectives,
  workerProgress,
  type WorkerContractRow,
  type WorkerStateRow,
  type WorkerSessionRow,
  type WorkerObjectiveRow,
  type WorkerProgressRow,
} from "../schema.js";
import { WorkerContractSchema, type WorkerContract, type WorkerStatus } from "../contracts/types.js";

const DEFAULT_TENANT = "turicks";

// ── Contract Persistence ─────────────────────────────────────────────────────

/**
 * Store a worker contract. Marks any previous versions as inactive and
 * stores this version as the currently active contract.
 */
export async function upsertWorkerContract(
  contract: WorkerContract,
  tenantId: string = DEFAULT_TENANT,
): Promise<WorkerContractRow> {
  const db = getDb();
  const workerId = contract.worker.id;
  const version = contract.worker.contractVersion;

  // Deactivate existing active versions for this worker
  await db
    .update(workerContracts)
    .set({ is_active: "false" })
    .where(
      and(
        eq(workerContracts.tenant_id, tenantId),
        eq(workerContracts.worker_id, workerId),
        eq(workerContracts.is_active, "true"),
      ),
    );

  const rows = await db
    .insert(workerContracts)
    .values({
      tenant_id: tenantId,
      worker_id: workerId,
      contract_version: version,
      contract: contract as any,
      is_active: "true",
    })
    .returning();

  const inserted = rows[0];
  if (!inserted) throw new Error(`Failed to insert worker contract for ${workerId}`);
  return inserted;
}

/**
 * Retrieve the active contract for a worker, or a specific version if requested.
 */
export async function getWorkerContract(
  workerId: string,
  version?: string,
  tenantId: string = DEFAULT_TENANT,
): Promise<WorkerContract | null> {
  const db = getDb();
  const conditions = [
    eq(workerContracts.tenant_id, tenantId),
    eq(workerContracts.worker_id, workerId),
  ];

  if (version) {
    conditions.push(eq(workerContracts.contract_version, version));
  } else {
    conditions.push(eq(workerContracts.is_active, "true"));
  }

  const [row] = await db
    .select()
    .from(workerContracts)
    .where(and(...conditions))
    .limit(1);

  if (!row) return null;

  const parsed = WorkerContractSchema.safeParse(row.contract);
  if (!parsed.success) {
    throw new Error(`Corrupted contract in database for worker "${workerId}": ${parsed.error.message}`);
  }

  return parsed.data;
}

// ── State Persistence ────────────────────────────────────────────────────────

/**
 * Retrieve the current lifecycle state row for a worker.
 */
export async function getWorkerState(
  workerId: string,
  tenantId: string = DEFAULT_TENANT,
): Promise<WorkerStateRow | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(workerState)
    .where(and(eq(workerState.tenant_id, tenantId), eq(workerState.worker_id, workerId)))
    .limit(1);

  return row ?? null;
}

/**
 * Upsert or update a worker's lifecycle state.
 */
export async function updateWorkerState(
  workerId: string,
  patch: {
    status?: WorkerStatus;
    contractVersion?: string;
    runtimeProvider?: string | null;
    runtimeId?: string | null;
    failureReason?: string | null;
    recoveryAttempts?: string;
  },
  tenantId: string = DEFAULT_TENANT,
): Promise<WorkerStateRow> {
  const db = getDb();
  const existing = await getWorkerState(workerId, tenantId);

  const values: Record<string, unknown> = {
    updated_at: new Date(),
    last_transition: new Date(),
  };

  if (patch.status !== undefined) values["status"] = patch.status;
  if (patch.contractVersion !== undefined) values["contract_version"] = patch.contractVersion;
  if (patch.runtimeProvider !== undefined) values["runtime_provider"] = patch.runtimeProvider;
  if (patch.runtimeId !== undefined) values["runtime_id"] = patch.runtimeId;
  if (patch.failureReason !== undefined) values["failure_reason"] = patch.failureReason;
  if (patch.recoveryAttempts !== undefined) values["recovery_attempts"] = patch.recoveryAttempts;

  if (existing) {
    const updatedRows = await db
      .update(workerState)
      .set(values)
      .where(and(eq(workerState.tenant_id, tenantId), eq(workerState.worker_id, workerId)))
      .returning();
    const updated = updatedRows[0];
    if (!updated) throw new Error(`Failed to update worker state for ${workerId}`);
    return updated;
  }

  const insertedRows = await db
    .insert(workerState)
    .values({
      tenant_id: tenantId,
      worker_id: workerId,
      status: patch.status ?? "CREATED",
      contract_version: patch.contractVersion ?? "1.0.0",
      runtime_provider: patch.runtimeProvider ?? null,
      runtime_id: patch.runtimeId ?? null,
      failure_reason: patch.failureReason ?? null,
      recovery_attempts: patch.recoveryAttempts ?? "0",
      ...values,
    })
    .returning();

  const inserted = insertedRows[0];
  if (!inserted) throw new Error(`Failed to insert worker state for ${workerId}`);
  return inserted;
}

// ── Session Persistence ──────────────────────────────────────────────────────

/**
 * Create a new execution session for a worker.
 */
export async function createWorkerSession(
  data: {
    workerId: string;
    sessionId: string;
    runtimeProvider: string;
    metadata?: Record<string, unknown>;
  },
  tenantId: string = DEFAULT_TENANT,
): Promise<WorkerSessionRow> {
  const db = getDb();
  const sessionRows = await db
    .insert(workerSessions)
    .values({
      tenant_id: tenantId,
      worker_id: data.workerId,
      session_id: data.sessionId,
      runtime_provider: data.runtimeProvider,
      status: "active",
      metadata: data.metadata ?? {},
    })
    .returning();

  const session = sessionRows[0];
  if (!session) throw new Error(`Failed to create worker session for ${data.workerId}`);
  return session;
}

/**
 * Update session state (e.g. on complete, crash, or pause).
 */
export async function updateWorkerSession(
  sessionId: string,
  patch: {
    status?: string;
    endedAt?: Date | null;
    metadata?: Record<string, unknown>;
  },
): Promise<WorkerSessionRow | null> {
  const db = getDb();
  const values: Record<string, unknown> = {};

  if (patch.status !== undefined) values["status"] = patch.status;
  if (patch.endedAt !== undefined) values["ended_at"] = patch.endedAt;
  if (patch.metadata !== undefined) values["metadata"] = patch.metadata;

  const [updated] = await db
    .update(workerSessions)
    .set(values)
    .where(eq(workerSessions.session_id, sessionId))
    .returning();

  return updated ?? null;
}

/**
 * Heartbeat an active session to prove the process is alive.
 */
export async function heartbeatWorkerSession(sessionId: string): Promise<void> {
  const db = getDb();
  await db
    .update(workerSessions)
    .set({ last_heartbeat: new Date() })
    .where(eq(workerSessions.session_id, sessionId));
}

/**
 * Retrieve the active session for a worker, if any.
 */
export async function getActiveWorkerSession(
  workerId: string,
  tenantId: string = DEFAULT_TENANT,
): Promise<WorkerSessionRow | null> {
  const db = getDb();
  const [session] = await db
    .select()
    .from(workerSessions)
    .where(
      and(
        eq(workerSessions.tenant_id, tenantId),
        eq(workerSessions.worker_id, workerId),
        eq(workerSessions.status, "active"),
      ),
    )
    .orderBy(desc(workerSessions.started_at))
    .limit(1);

  return session ?? null;
}

// ── Progress Persistence ────────────────────────────────────────────────────

/**
 * Record a progress report entry for a worker.
 */
export async function recordWorkerProgress(
  data: {
    workerId: string;
    status: string;
    summary: string;
    missionId?: string;
    taskId?: string;
    blockers?: string[];
    nextAction?: string;
  },
  tenantId: string = DEFAULT_TENANT,
): Promise<WorkerProgressRow> {
  const db = getDb();
  const rows = await db
    .insert(workerProgress)
    .values({
      tenant_id: tenantId,
      worker_id: data.workerId,
      status: data.status,
      summary: data.summary,
      mission_id: data.missionId ?? null,
      task_id: data.taskId ?? null,
      blockers: data.blockers ?? null,
      next_action: data.nextAction ?? null,
    })
    .returning();

  const row = rows[0];
  if (!row) throw new Error(`Failed to record worker progress for ${data.workerId}`);
  return row;
}

/**
 * Get recent progress reports for a worker.
 */
export async function getRecentWorkerProgress(
  workerId: string,
  limit: number = 10,
  tenantId: string = DEFAULT_TENANT,
): Promise<WorkerProgressRow[]> {
  const db = getDb();
  return await db
    .select()
    .from(workerProgress)
    .where(and(eq(workerProgress.tenant_id, tenantId), eq(workerProgress.worker_id, workerId)))
    .orderBy(desc(workerProgress.created_at))
    .limit(limit);
}

// ── Crash Recovery ──────────────────────────────────────────────────────────

/**
 * Reclaim workers stranded in RUNNING status across process crash / restart.
 */
export async function reclaimStrandedWorkers(
  maxAttempts: number = 3,
  tenantId: string = DEFAULT_TENANT,
): Promise<{ recovered: WorkerStateRow[]; failed: WorkerStateRow[] }> {
  const db = getDb();

  // Find all workers that were left in RUNNING status
  const stranded = await db
    .select()
    .from(workerState)
    .where(and(eq(workerState.tenant_id, tenantId), eq(workerState.status, "RUNNING")));

  const recovered: WorkerStateRow[] = [];
  const failed: WorkerStateRow[] = [];

  for (const worker of stranded) {
    const attempts = parseInt(worker.recovery_attempts ?? "0", 10);
    if (attempts >= maxAttempts) {
      // Exceeded crash attempts — fail loud
      const updatedRows = await db
        .update(workerState)
        .set({
          status: "FAILED",
          failure_reason: `Stranded in RUNNING by crash; exceeded max recovery attempts (${maxAttempts})`,
          last_transition: new Date(),
          updated_at: new Date(),
        })
        .where(and(eq(workerState.tenant_id, tenantId), eq(workerState.worker_id, worker.worker_id)))
        .returning();
      if (updatedRows[0]) failed.push(updatedRows[0]);
    } else {
      // Reclaim: mark PAUSED with recovery attempt bumped
      const nextAttempts = (attempts + 1).toString();
      const updatedRows = await db
        .update(workerState)
        .set({
          status: "PAUSED",
          recovery_attempts: nextAttempts,
          failure_reason: `Reclaimed from crash in RUNNING state (attempt ${nextAttempts}/${maxAttempts})`,
          last_transition: new Date(),
          updated_at: new Date(),
        })
        .where(and(eq(workerState.tenant_id, tenantId), eq(workerState.worker_id, worker.worker_id)))
        .returning();
      if (updatedRows[0]) recovered.push(updatedRows[0]);
    }
  }

  return { recovered, failed };
}

