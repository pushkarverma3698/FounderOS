/**
 * FounderOS — Pre-Router
 * =======================
 * Fires BEFORE the supervisor LLM to give Gemini a routing hint (or to
 * force-route deterministic cases without an LLM call at all).
 *
 * Two layers:
 *  1. Deterministic regex rules (preRoutePersonalVsEngineering) — pure, no I/O
 *  2. Local Ollama classifier (localClassifyDept) — async, gracefully degrades
 *
 * Both return null to let the supervisor decide normally.
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
