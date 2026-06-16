/**
 * FounderOS — Context Isolation Guard (CLAUDE rule #20)
 * =====================================================
 * The supervisor and every nested sub-supervisor MUST run with
 * `outputMode: "last_message"` so a department's internal tool calls/results
 * never propagate up into the parent's history (context leakage). The library
 * default is "last_message", but "full_history" is one typo away and would
 * silently re-open the leak — the exact failure class rule #20 forbids.
 *
 * This converts that silent regression into a LOUD boot-time throw: every
 * `createSupervisor` call passes its mode through `assertContextIsolation`,
 * so a future change to "full_history" crashes the office build instead of
 * quietly leaking context in production. A structural test additionally
 * forbids the literal "full_history" anywhere under src/agents.
 */

export const CONTEXT_ISOLATION_OUTPUT_MODE = "last_message" as const;

export type ContextIsolationMode = typeof CONTEXT_ISOLATION_OUTPUT_MODE;

/**
 * Assert a supervisor outputMode preserves context isolation.
 * Returns the mode (typed) when valid; throws loudly otherwise.
 */
export function assertContextIsolation(mode: string): ContextIsolationMode {
  if (mode !== CONTEXT_ISOLATION_OUTPUT_MODE) {
    throw new Error(
      `Context isolation violation (CLAUDE rule #20): supervisor outputMode must be ` +
        `"${CONTEXT_ISOLATION_OUTPUT_MODE}", got "${mode}". "full_history" leaks a ` +
        `department's internal tool calls/results into the parent supervisor's history. ` +
        `Revert to "${CONTEXT_ISOLATION_OUTPUT_MODE}".`,
    );
  }
  return CONTEXT_ISOLATION_OUTPUT_MODE;
}
