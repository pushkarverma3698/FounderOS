/**
 * Wedged-thread detection.
 *
 * When an office run terminates abnormally mid-graph (recursion limit, budget
 * exceeded, process crash), the LangGraph checkpoint is left with `state.next`
 * pointing at a half-executed node and NO HITL interrupt pending. Every later
 * `office.invoke({ messages })` then RESUMES that stuck node instead of starting
 * a fresh turn, so the thread loops to the recursion limit on every message and
 * only a manual /reset recovers it.
 *
 * This is a pure predicate (rule #16: deterministic logic is a unit-tested pure
 * function, never a prompt instruction). The recovery action lives in the
 * gateway; this only decides whether a thread is wedged.
 */

/** Minimal shape of a LangGraph snapshot we need to classify a wedge. */
export interface WedgeState {
  next?: readonly string[];
  tasks?: ReadonlyArray<{ interrupts?: readonly unknown[] }>;
}

/** Count pending HITL interrupts across all parked tasks. */
export function pendingInterruptCount(state: WedgeState | null | undefined): number {
  if (!state) return 0;
  return (state.tasks ?? []).reduce((n, t) => n + (t.interrupts?.length ?? 0), 0);
}

/**
 * A thread is WEDGED when the graph has a pending node (`next` non-empty) but
 * NO HITL interrupt is waiting. A legitimate approval pause also has a pending
 * node, so the interrupt check is what distinguishes "waiting on the founder"
 * (healthy) from "stuck on an aborted run" (wedged).
 */
export function isWedgedState(state: WedgeState | null | undefined): boolean {
  if (!state) return false;
  const hasPendingNode = (state.next?.length ?? 0) > 0;
  if (!hasPendingNode) return false;
  return pendingInterruptCount(state) === 0;
}
