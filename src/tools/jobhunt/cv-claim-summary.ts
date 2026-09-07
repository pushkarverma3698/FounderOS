/**
 * FounderOS — how a blocked CV is explained to the founder
 * ========================================================
 * `verifyCvClaims` decides; this renders its verdict. They are separate files
 * because the guard is already at the 400-line budget and because the two
 * change for different reasons: a new check is a guard change, a clearer
 * message is a rendering change.
 *
 * WHY IT EXISTS. Each `CvClaimViolation.reason` is a full explanatory sentence
 * written for a developer reading a log ("...but extractSkillTerms finds no
 * mention of it anywhere in the base CV"). `tailorCv` used to join all of them
 * into one error string, and `/draft` clipped that string at 200 characters.
 * PROD 2026-09-07: the founder's message ended `... [technology] "TD)` — one
 * and a half reasons, cut mid-word, with the rest of the fabricated list
 * invisible. He could see that the CV was blocked and not what was wrong with
 * it, which is the half of the message that has an action attached.
 *
 * The claims are the information. The prose around them is not.
 */

import type { CvClaimKind, CvClaimViolation } from "./cv-claim-guard.js";

/** Claims named per kind before the summary switches to "+N more". */
const SUMMARY_CLAIM_CAP = 6;

/** One short line naming what was ungrounded, grouped by kind. */
export function describeClaimViolations(violations: readonly CvClaimViolation[]): string {
  const byKind = new Map<CvClaimKind, string[]>();
  for (const v of violations) {
    byKind.set(v.kind, [...(byKind.get(v.kind) ?? []), v.claim]);
  }

  const groups = [...byKind].map(([kind, claims]) => {
    const shown = claims.slice(0, SUMMARY_CLAIM_CAP).join(", ");
    const extra = claims.length - SUMMARY_CLAIM_CAP;
    return `${kind}: ${shown}${extra > 0 ? ` (+${extra} more)` : ""}`;
  });

  const noun = violations.length === 1 ? "1 thing" : `${violations.length} things`;
  return `Tailored CV names ${noun} the base CV never states — ${groups.join("; ")}`;
}
