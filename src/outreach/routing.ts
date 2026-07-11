/**
 * Pure routing functions for the outreach reflection graph (rule #16).
 */

import { OUTREACH_MAX_RETRIES } from "./contracts.js";
import type { OutreachGraphState } from "./state.js";

export type OutreachRoute = "reflector" | "executor" | "end";

export function routeAfterValidator(state: OutreachGraphState): OutreachRoute {
  if (state.validation_errors.length === 0) return "executor";
  if (state.retry_count < OUTREACH_MAX_RETRIES) return "reflector";
  return "end";
}

export function terminalFailureReason(state: OutreachGraphState): string {
  if (state.failure_reason) return state.failure_reason;
  if (state.validation_errors.length === 0) return "Unknown failure";
  return `Validation failed after ${state.retry_count} reflection(s): ${state.validation_errors.join("; ")}`;
}

export function isTerminalFailure(state: OutreachGraphState): boolean {
  return (
    state.status === "failed" ||
    (state.validation_errors.length > 0 && state.retry_count >= OUTREACH_MAX_RETRIES)
  );
}

export { OUTREACH_MAX_RETRIES };
