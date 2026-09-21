/**
 * AG-015/B7 — resume-artifact cleanup.
 * =====================================
 * `interrupt()` re-executing during a resume re-inserts a pending
 * `hitl_approvals` row as a side effect (`hitlGate` cannot tell a resume
 * re-run from a fresh gate). The graph checkpoint is the source of truth: if
 * it is NOT genuinely paused, any still-pending row for this thread is that
 * artifact, not a real approval — resolve it with the founder's decision so
 * no phantom card can ever be restored (`restorePendingApproval`).
 *
 * Split out of kernel-run.ts (LOC budget 400) — same reason kernel-progress.ts
 * exists: this run loop keeps growing under changes to its own contract.
 *
 * Previously this cleanup ran only after resumeKernel's stream settled
 * successfully without re-pausing, so a timeout (or any other error) left the
 * artifact orphaned forever. The caller now runs this from a `finally` around
 * the stream, on every exit — success, re-pause, timeout, or any other error.
 */
import type { RunnableConfig } from "@langchain/core/runnables";
import { getPendingKernelApproval } from "../kernel/index.js";
import { getPendingInterrupt, resolveInterrupt } from "../db/queries.js";
import type { ApprovalRequest } from "../infra/hitl.js";
import { logger } from "../infra/logger.js";

const log = logger.child({ module: "resume-artifact-cleanup" });

/**
 * `knownApproval` is whatever the caller already determined this resume
 * paused on (or `null` if it never got that far, e.g. a timeout) — passing it
 * avoids a redundant checkpoint read on the common success path. When it's
 * `null` this re-checks the checkpoint itself before touching anything, so a
 * genuine new pause is never swallowed even in the narrow case where
 * `interrupt()` fires at nearly the same moment as an abort. Never throws —
 * this is best-effort cleanup layered on top of the turn's own result/error,
 * which must still propagate to the caller untouched.
 */
export async function cleanupResumeArtifact(
  kernel: { getState: (c: RunnableConfig) => Promise<unknown> },
  config: RunnableConfig,
  threadId: string,
  decision: "approved" | "rejected",
  knownApproval: ApprovalRequest | null,
): Promise<void> {
  try {
    // allow-failopen: an unreadable checkpoint falls through to "not paused" — the outer catch below still logs any real failure.
    const stillPaused = knownApproval ?? ((await getPendingKernelApproval(kernel, config).catch(() => null)) as ApprovalRequest | null);
    if (stillPaused) return;
    const orphan = await getPendingInterrupt(threadId);
    if (orphan) await resolveInterrupt(orphan.interrupt_id, decision);
  } catch (cleanupErr) {
    log.warn({ err: String(cleanupErr) }, "B7 resume-artifact cleanup failed"); // allow-failopen: best-effort cleanup layered on top of the turn's own result/error, which still propagates correctly
  }
}
