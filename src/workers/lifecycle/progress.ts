/**
 * FounderOS — Worker Progress Reporting
 * ========================================
 * Typed progress reports from workers back to FounderOS. Enables queries like
 * "Where are we on LinkedIn outreach?" without depending on the current runtime
 * session — progress is persisted in FounderOS, not the runtime.
 *
 * In-memory store for this milestone. The interface is ready for Postgres
 * persistence via the worker_progress table when migrated.
 */

// ── Progress report ──────────────────────────────────────────────────────────

export const PROGRESS_STATUSES = ["in_progress", "completed", "blocked", "failed"] as const;
export type ProgressStatus = (typeof PROGRESS_STATUSES)[number];

export interface WorkerProgressReport {
  workerId: string;
  missionId?: string;
  taskId?: string;
  status: ProgressStatus;
  summary: string;
  blockers?: string[];
  nextAction?: string;
  timestamp: string;
}

// ── Progress store ───────────────────────────────────────────────────────────

/** Interface for persisting and querying progress reports. */
export interface WorkerProgressStore {
  record(report: WorkerProgressReport): Promise<void>;
  getLatest(workerId: string, limit?: number): Promise<WorkerProgressReport[]>;
  getByMission(missionId: string, limit?: number): Promise<WorkerProgressReport[]>;
}

/**
 * In-memory progress store. Tests and this milestone use this implementation.
 * A Postgres-backed implementation will write to worker_progress when migrated.
 */
export class InMemoryProgressStore implements WorkerProgressStore {
  private reports: WorkerProgressReport[] = [];

  async record(report: WorkerProgressReport): Promise<void> {
    this.reports.push({ ...report });
  }

  async getLatest(workerId: string, limit = 10): Promise<WorkerProgressReport[]> {
    return this.reports
      .filter((r) => r.workerId === workerId)
      .slice(-limit);
  }

  async getByMission(missionId: string, limit = 10): Promise<WorkerProgressReport[]> {
    return this.reports
      .filter((r) => r.missionId === missionId)
      .slice(-limit);
  }

  /** Total reports recorded (for testing). */
  get count(): number {
    return this.reports.length;
  }
}
