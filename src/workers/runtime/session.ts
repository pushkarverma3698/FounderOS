/**
 * FounderOS — Worker Runtime Session
 * ====================================
 * Represents an active execution session for a persistent digital worker.
 * Tracks session liveness, heartbeats, and checkpoint metadata.
 */

import { randomUUID } from "node:crypto";
import {
  createWorkerSession,
  updateWorkerSession,
  heartbeatWorkerSession,
  getActiveWorkerSession,
} from "../db/queries.js";

export type SessionStatus = "active" | "paused" | "completed" | "failed" | "terminated";

export interface SessionOptions {
  sessionId?: string;
  workerId: string;
  runtimeProvider: string;
  metadata?: Record<string, unknown>;
  persist?: boolean;
}

export class WorkerRuntimeSession {
  readonly sessionId: string;
  readonly workerId: string;
  readonly runtimeProvider: string;
  readonly startedAt: Date;
  lastHeartbeat: Date;
  status: SessionStatus;
  metadata: Record<string, unknown>;
  private readonly persist: boolean;

  constructor(options: SessionOptions) {
    this.sessionId = options.sessionId ?? `sess_${options.workerId}_${randomUUID().slice(0, 8)}`;
    this.workerId = options.workerId;
    this.runtimeProvider = options.runtimeProvider;
    this.startedAt = new Date();
    this.lastHeartbeat = new Date();
    this.status = "active";
    this.metadata = options.metadata ?? {};
    this.persist = options.persist ?? true;
  }

  /**
   * Update the session heartbeat to signal liveness.
   */
  async heartbeat(): Promise<void> {
    this.lastHeartbeat = new Date();
    if (this.persist) {
      try {
        await heartbeatWorkerSession(this.sessionId);
      } catch {
        // Heartbeat failure is non-fatal; state remains in memory
      }
    }
  }

  /**
   * Update checkpoint or execution metadata.
   */
  async updateMetadata(patch: Record<string, unknown>): Promise<void> {
    this.metadata = { ...this.metadata, ...patch };
    if (this.persist) {
      try {
        await updateWorkerSession(this.sessionId, { metadata: this.metadata });
      } catch {
        // Non-fatal
      }
    }
  }

  /**
   * Terminate or conclude the session.
   */
  async end(status: SessionStatus, exitReason?: string): Promise<void> {
    this.status = status;
    const endedAt = new Date();
    if (exitReason) {
      this.metadata["exitReason"] = exitReason;
    }
    if (this.persist) {
      try {
        await updateWorkerSession(this.sessionId, {
          status,
          endedAt,
          metadata: this.metadata,
        });
      } catch {
        // Non-fatal
      }
    }
  }
}

/**
 * In-memory registry and lifecycle manager for active runtime sessions.
 */
export class WorkerSessionManager {
  private activeSessions = new Map<string, WorkerRuntimeSession>();

  /**
   * Create and register a new active session for a worker.
   */
  async createSession(
    workerId: string,
    runtimeProvider: string,
    metadata?: Record<string, unknown>,
    persist: boolean = true,
  ): Promise<WorkerRuntimeSession> {
    // If an active session already exists, close it cleanly first
    const existing = this.activeSessions.get(workerId);
    if (existing && existing.status === "active") {
      await existing.end("terminated", "Superseded by new session");
    }

    const session = new WorkerRuntimeSession({
      workerId,
      runtimeProvider,
      metadata,
      persist,
    });

    if (persist) {
      try {
        await createWorkerSession({
          workerId,
          sessionId: session.sessionId,
          runtimeProvider,
          metadata: session.metadata,
        });
      } catch {
        // In-memory operation succeeds even if DB is unavailable
      }
    }

    this.activeSessions.set(workerId, session);
    return session;
  }

  /**
   * Get the active session for a worker from memory, or check the database.
   */
  async getSession(workerId: string, checkDb: boolean = true): Promise<WorkerRuntimeSession | null> {
    const memorySession = this.activeSessions.get(workerId);
    if (memorySession && memorySession.status === "active") {
      return memorySession;
    }

    if (!checkDb) return null;

    try {
      const dbRow = await getActiveWorkerSession(workerId);
      if (dbRow) {
        const restored = new WorkerRuntimeSession({
          sessionId: dbRow.session_id,
          workerId: dbRow.worker_id,
          runtimeProvider: dbRow.runtime_provider,
          metadata: (dbRow.metadata as Record<string, unknown>) ?? {},
          persist: true,
        });
        restored.lastHeartbeat = dbRow.last_heartbeat ?? new Date();
        this.activeSessions.set(workerId, restored);
        return restored;
      }
    } catch {
      // Return null on DB error
    }

    return null;
  }

  /**
   * Close a worker's active session.
   */
  async closeSession(workerId: string, status: SessionStatus, reason?: string): Promise<void> {
    const session = this.activeSessions.get(workerId);
    if (session) {
      await session.end(status, reason);
      this.activeSessions.delete(workerId);
    }
  }

  /**
   * Sweep stale sessions whose heartbeat is older than maxIdleMs.
   */
  async sweepStaleSessions(maxIdleMs: number = 5 * 60 * 1000): Promise<string[]> {
    const now = Date.now();
    const staleWorkerIds: string[] = [];

    for (const [workerId, session] of this.activeSessions.entries()) {
      if (now - session.lastHeartbeat.getTime() > maxIdleMs) {
        await session.end("failed", "Session heartbeat timed out (stale)");
        this.activeSessions.delete(workerId);
        staleWorkerIds.push(workerId);
      }
    }

    return staleWorkerIds;
  }
}
