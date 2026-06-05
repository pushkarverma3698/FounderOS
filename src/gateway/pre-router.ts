/**
 * FounderOS — Pre-Router (deterministic, LLM-free)
 * ==================================================
 * Pure functions that fire BEFORE the supervisor LLM to force-route certain
 * inputs to the correct department without an LLM call.
 *
 * Rules:
 *  - Pure functions: no LLM, no I/O, fully testable.
 *  - Return null to let the supervisor decide normally.
 *  - Return a department name to force-route.
 *
 * Wiring into telegram.ts is a separate step (not done in this pass).
 */

/**
 * Pre-router: deterministic rules that fire BEFORE the supervisor LLM.
 * Returns a dept name to force-route to, or null to let the supervisor decide.
 */
export function preRoutePersonalVsEngineering(input: string): "personal" | "engineering" | null {
  // GitHub / repo intent → engineering, regardless of path mentions
  if (/github|repositor|repo\b/i.test(input)) return "engineering";

  // Filesystem paths on the local machine → personal
  if (/~\/|\/Users\/pushkarverma|desktop|downloads|documents|home folder/i.test(input)) {
    return "personal";
  }

  return null;
}

/**
 * Returns true when the input is clearly a cold-outreach request.
 * Pure predicate — used for routing hints and tests.
 */
export function isOutreachRequest(input: string): boolean {
  return /\boutreach\b|\bcold email\b|\breach out\b/i.test(input);
}
