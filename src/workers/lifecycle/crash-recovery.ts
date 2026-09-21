/**
 * FounderOS — Worker Crash Recovery
 * ===================================
 * Boot-time crash recovery for persistent digital workers.
 *
 * A process crash (OOM, restart, unhandled exception) leaves workers with
 * their status recorded as RUNNING in Postgres. At boot, this module detects
 * stranded workers and safely reclaims or fails them based on retry policies,
 * preventing silent worker death.
 *
 * Follows the same pattern as recoverStrandedScheduledTasks() and
 * resumeInterruptedMission().
 */

import { logger } from "../../infra/logger.js";
import { reclaimStrandedWorkers } from "../db/queries.js";
import type { WorkerRuntimeOrchestrator } from "../runtime/orchestrator.js";

const log = logger.child({ module: "worker-crash-recovery" });

export const MAX_WORKER_RECOVERY_ATTEMPTS = 3;

export interface RecoveryResult {
  recovered: string[];
  failed: string[];
}

/**
 * Scan for and recover workers stranded in RUNNING status across a crash or reboot.
 * Called once during application boot.
 */
export async function recoverStrandedWorkers(
  orchestrator?: WorkerRuntimeOrchestrator,
  maxAttempts: number = MAX_WORKER_RECOVERY_ATTEMPTS,
): Promise<RecoveryResult> {
  try {
    const { recovered, failed } = await reclaimStrandedWorkers(maxAttempts);

    const recoveredIds = recovered.map((r) => r.worker_id);
    const failedIds = failed.map((f) => f.worker_id);

    if (recoveredIds.length > 0 || failedIds.length > 0) {
      log.warn(
        { recovered: recoveredIds, failed: failedIds },
        "Reclaimed digital workers stranded in 'RUNNING' status by a crash or restart",
      );
    }

    // If an orchestrator instance was provided, synchronize its in-memory lifecycle manager
    if (orchestrator) {
      for (const row of recovered) {
        // Paused state
        const state = orchestrator.getState(row.worker_id);
        if (state) {
          try {
            orchestrator["lifecycleManager"].pause(row.worker_id);
          } catch {
            // Ignore if in-memory state cannot transition
          }
        }
      }
      for (const row of failed) {
        const state = orchestrator.getState(row.worker_id);
        if (state) {
          try {
            orchestrator["lifecycleManager"].fail(row.worker_id, row.failure_reason ?? "Crash limit exceeded");
          } catch {
            // Ignore
          }
        }
      }
    }

    return {
      recovered: recoveredIds,
      failed: failedIds,
    };
  } catch (err) {
    log.warn(
      { err: (err as Error).message },
      "Worker crash recovery check skipped or failed — non-fatal at boot",
    );
    return { recovered: [], failed: [] };
  }
}
