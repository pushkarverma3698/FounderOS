/**
 * FounderOS — is the judge actually running?
 * ==========================================
 * A fail-open gate that cannot say it is down is not a gate; it is a comment.
 *
 * WHAT THIS EXISTS TO STOP. `judgeOutbound` is gate 2 for every outbound draft
 * and it fails open on purpose — a judge that blocks the founder on its own
 * confusion is worse than no judge, and HITL is the real gate. The cost of that
 * choice is that an OUTAGE and a PASS are the same observable event. Three times
 * in three weeks the configured free OpenRouter slug was withdrawn
 * (meta-llama/llama-3.3-70b-instruct:free, nvidia/nemotron-3-super…:free in
 * content-judge, then minimax/minimax-m2.7:free), and each time the gate became
 * a silent no-op that only a raw log grep could find. On 2026-09-07 a slug was
 * replaced, deployed, and 404'd again the same evening — 21:54:47, 21:56:14,
 * 21:57:15, once per real outbound reply — with nothing surfacing it.
 *
 * The fix is not another slug. It is that failing open must leave a mark. This
 * module holds that mark: a process-local counter the judge writes on every
 * failure and clears on every success, which the hourly scheduler reads to send
 * the founder ONE message per outage episode.
 *
 * Enforced by: `sendJudgeOutageAlertIfNeeded` on the hourly cron in
 * scheduler.ts. Not by goodwill, and not by a comment asking someone to grep.
 */

/** Failures in a row before the founder is told. One transient 500 is not an outage. */
export const JUDGE_OUTAGE_THRESHOLD = 3;

interface JudgeHealthState {
  consecutiveFailures: number;
  lastError: string;
  lastFailureAt: number;
  /** True once an alert has been sent for the CURRENT episode — reset by a success. */
  alerted: boolean;
}

const state: JudgeHealthState = {
  consecutiveFailures: 0,
  lastError: "",
  lastFailureAt: 0,
  alerted: false,
};

/** Record one judge call that could not produce a verdict. */
export function recordJudgeFailure(error: string, now: number = Date.now()): void {
  state.consecutiveFailures += 1;
  state.lastError = error;
  state.lastFailureAt = now;
}

/** Record one judge call that did. Ends the episode, so the next outage alerts again. */
export function recordJudgeSuccess(): void {
  state.consecutiveFailures = 0;
  state.lastError = "";
  state.alerted = false;
}

export interface JudgeHealth {
  readonly consecutiveFailures: number;
  readonly lastError: string;
  readonly lastFailureAt: number;
  readonly alerted: boolean;
  /** Past the threshold and not yet announced — the founder should hear about it. */
  readonly shouldAlert: boolean;
}

export function judgeHealth(): JudgeHealth {
  return {
    consecutiveFailures: state.consecutiveFailures,
    lastError: state.lastError,
    lastFailureAt: state.lastFailureAt,
    alerted: state.alerted,
    shouldAlert: state.consecutiveFailures >= JUDGE_OUTAGE_THRESHOLD && !state.alerted,
  };
}

/** Mark the current episode as announced so the hourly check does not repeat itself. */
export function markJudgeOutageAlerted(): void {
  state.alerted = true;
}

/** Test seam. */
export function _resetJudgeHealth(): void {
  state.consecutiveFailures = 0;
  state.lastError = "";
  state.lastFailureAt = 0;
  state.alerted = false;
}
