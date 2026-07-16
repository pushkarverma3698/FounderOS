/**
 * FounderOS — failed-turn history fold (gateway seam)
 * =====================================================
 * A hard-failed turn (timeout / model exhaustion / crash) leaves reply="" in
 * the checkpoint, so summarizePreviousTurn skips it and the NEXT turn plans
 * with no memory of the failure — live 2026-07-12 33f64116: "Try again"
 * retried the email task from two turns earlier instead of the LinkedIn task
 * that had just died. Writing the failure into the thread state makes the
 * planner fold it into history as a "[turn failed]" entry.
 */

import { TurnTimeoutError } from "./turn-timeout.js";
import { BudgetExceededError } from "../infra/budget.js";
import { DailyBudgetExceededError } from "../infra/daily-budget.js";
import { logger } from "../infra/logger.js";
import type { FailureStage } from "../kernel/index.js";

const log = logger.child({ module: "failed-turn-fold" });

/** Minimal checkpoint surface the fold needs (the compiled graph satisfies it). */
export interface FoldableKernel {
  getState(config: unknown): Promise<{ values?: { turn?: unknown; mission?: unknown } } | undefined>;
  updateState?(config: unknown, values: Record<string, unknown>, asNode?: string): Promise<unknown>;
}

export function failureStageForError(err: unknown): FailureStage {
  if (err instanceof TurnTimeoutError) return "timeout";
  if (err instanceof BudgetExceededError || err instanceof DailyBudgetExceededError) return "budget";
  return "model";
}

/**
 * Best-effort: the founder error reply must go out even if this write fails.
 * Attributed to the "plan" node — the same node that owns these channels on
 * every normal turn; the next message restarts the graph from START anyway.
 */
export async function recordFailedTurnInHistory(
  kernel: FoldableKernel,
  config: unknown,
  err: unknown,
): Promise<void> {
  try {
    if (!kernel.updateState) return;
    const snapshot = await kernel.getState(config);
    const turn = snapshot?.values?.turn as { id?: string } | undefined;
    if (!turn?.id) return;
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    // A hard-failed turn otherwise leaves mission.status="executing" (cursor
    // mid-plan) in the checkpoint, and the NEXT turn's progress stream shows
    // the dead task's label until its plan node returns (live 2026-07-13
    // 8e045446). Same terminal shape the plan node writes on failure.
    const staleMission = snapshot?.values?.mission as { goal?: string } | undefined;
    await kernel.updateState(
      config,
      {
        last_turn: turn,
        mission: { goal: staleMission?.goal ?? "", status: "failed", plan: null, cursor: 0 },
        failure: {
          step_id: "turn",
          stage: failureStageForError(err),
          component: "gateway/kernel-run",
          message,
          retryable: true,
        },
        reply: `The turn stopped before completing: ${message}`,
      },
      "plan",
    );
  } catch (foldErr) {
    log.warn({ err: String(foldErr) }, "Failed-turn history fold skipped"); // allow-failopen: fold is best-effort; the founder error reply must still be sent
  }
}
