/**
 * FounderOS — Supervisor Router Gateway
 * =====================================
 * Supervisor router integrating Jev AI System 1 deterministic gateway for fast,
 * low-latency decision making before falling back to full kernel dispatch / LLM processing.
 */

import { evaluateJevSystem1Route, type JevSystem1RouteResult } from "../services/jev-ai.js";
import type { KernelStateType, KernelUpdate } from "../kernel/state.js";
import {
  dispatch as kernelDispatch,
  routeAfterDispatch as kernelRouteAfterDispatch,
  routeAfterPlan as kernelRouteAfterPlan,
  MAX_ATTEMPTS_PER_STEP,
  formatFailureReply,
  retryMessage,
  resolveInputs,
  envelopeMessage,
} from "../kernel/supervisor.js";

export interface SupervisorRouteInput {
  intent?: string;
  prompt?: string;
  state?: KernelStateType;
}

/**
 * Evaluate supervisor routing decision.
 * Invokes Jev AI gateway for fast System 1 deterministic routing decision.
 * If Jev AI does not match or is unavailable, falls back to standard kernel dispatch logic.
 */
export function evaluateSupervisorRoute(input: SupervisorRouteInput): JevSystem1RouteResult {
  const system1Result = evaluateJevSystem1Route(input);
  if (system1Result.handled) {
    return system1Result;
  }

  // Fallback to standard supervisor routing
  return {
    handled: false,
    reason: system1Result.reason ?? "Fallback to standard supervisor LLM dispatch",
  };
}

export const dispatch = kernelDispatch;
export const routeAfterDispatch = kernelRouteAfterDispatch;
export const routeAfterPlan = kernelRouteAfterPlan;

export {
  MAX_ATTEMPTS_PER_STEP,
  formatFailureReply,
  retryMessage,
  resolveInputs,
  envelopeMessage,
};
