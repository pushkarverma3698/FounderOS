/**
 * core-phase — the deterministic cognitive-state machine for the JARVIS core.
 * ===========================================================================
 * A turn moves the orb through three phases:
 *
 *   idle ──send──▶ thinking ──turn_complete──▶ verifying ──settle──▶ idle
 *                     │                                                 ▲
 *                     └──────────────turn_error─────────────────────────┘
 *
 * `verifying` is the cinematic "Deep Thought" beat the design brief asks for:
 * after the office signals completion, the orb spends a short, fixed window
 * collapsing + validating the result before the canvas settles back to idle.
 *
 * This is a pure reducer on purpose (project rule #16 — determinism): all phase
 * logic lives here as a unit-testable function, never as ad-hoc setState calls
 * scattered through the stream hook.
 */

export type CorePhase = "idle" | "thinking" | "verifying";

export type CorePhaseEvent =
  | "send" // founder transmitted a message
  | "turn_complete" // office finished the turn successfully
  | "turn_error" // office failed
  | "settle" // verify window elapsed
  | "reset"; // hard reset (timeout / manual idle)

/** Duration of the `verifying` beat, in ms, before the canvas settles. */
export const VERIFY_SETTLE_MS = 1400;

/** Safety ceiling: force back to idle if a turn never reports completion. */
export const THINKING_TIMEOUT_MS = 120_000;

/** Pure transition function. Same (phase, event) → same next phase, always. */
export function nextCorePhase(current: CorePhase, event: CorePhaseEvent): CorePhase {
  switch (event) {
    case "send":
      return "thinking";
    case "turn_complete":
      return "verifying";
    case "turn_error":
    case "settle":
    case "reset":
      return "idle";
    default:
      return current;
  }
}
