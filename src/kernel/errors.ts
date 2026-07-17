/**
 * FounderOS v3 kernel — terminal-error taxonomy for in-graph self-correction.
 * ============================================================================
 * The agent and synthesizer nodes intercept model errors and degrade them to
 * typed, retryable FailureReports so a transient provider blip retries INSIDE
 * the graph instead of aborting the whole mission (pre-2026-07-13 behaviour:
 * one worker-model throw killed a multi-step mission and discarded every
 * completed step).
 *
 * Interception must NEVER swallow the errors that the surrounding machinery
 * depends on seeing raw:
 *   - GraphInterrupt      → the HITL pause signal; the checkpoint stops here.
 *   - BudgetExceededError / DailyBudgetExceededError → hard spend caps; the
 *     gateway renders the dedicated budget reply and the run must stop NOW.
 *   - AbortError          → the turn-timeout guard aborted the run; retrying
 *     inside an aborted run would race the founder's next message.
 *   - TurnTimeoutError    → same deadline, surfaced by the wrapper itself.
 *
 * Detection is by error NAME, not instanceof: budget/timeout classes live in
 * src/infra and src/gateway, and provider SDKs re-wrap AbortError — the name
 * survives wrapping and keeps the kernel import-light.
 */

import { isGraphInterrupt } from "@langchain/langgraph";

const TERMINAL_ERROR_NAMES = new Set([
  "BudgetExceededError",
  "DailyBudgetExceededError",
  "AbortError",
  "TurnTimeoutError",
]);

/** True when `err` must propagate out of the graph untouched (see module doc). */
export function isKernelTerminalError(err: unknown): boolean {
  if (isGraphInterrupt(err)) return true;
  if (err instanceof Error && TERMINAL_ERROR_NAMES.has(err.name)) return true;
  // Node's fetch/undici abort carries name "AbortError" on a DOMException,
  // which is not an Error subclass in every runtime — check the shape too.
  const name = (err as { name?: unknown } | null | undefined)?.name;
  return typeof name === "string" && TERMINAL_ERROR_NAMES.has(name);
}

/** Bounded, single-line rendering of an intercepted error for FailureReport.message. */
export function describeInterceptedError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/\s+/g, " ").trim().slice(0, 300);
}
