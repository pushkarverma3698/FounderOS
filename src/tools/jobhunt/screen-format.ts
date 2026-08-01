/**
 * FounderOS — screen_job's reply
 * ==============================
 * The plain-text rendering of ONE screening outcome, for when the founder pastes
 * a posting himself. Split out of screen.ts so that file stays about applying
 * gates, and so the wording can change without touching the decision logic.
 *
 * Deliberately plain text, not the brief's HTML: this is a direct answer to a
 * direct question, and it goes through the transport's whole-message escape.
 */

import { gateProfile } from "./permit-routes.js";
import { gateMark } from "./gates.js";
import type { ScreenOutcome } from "./screen.js";

/** Render a screening outcome for the founder. Pure — no I/O, no state. */
export function formatScreenOutcome(
  outcome: Extract<ScreenOutcome, { kind: "duplicate" | "screened" }>,
): string {
  if (outcome.kind === "duplicate") {
    const applied = outcome.appliedAt
      ? ` (applied ${outcome.appliedAt.toISOString().slice(0, 10)})`
      : "";
    return (
      `ALREADY IN PIPELINE — ${outcome.company} · ${outcome.title}\n` +
      `Stage: ${outcome.stage}${applied}\n` +
      `Do not apply again. Follow up on the existing application instead.`
    );
  }

  const { company, title, route, verdict, routesTried, match, nearDuplicates } = outcome;
  const routeLabel = gateProfile(route).label;
  const header =
    verdict.status === "reject"
      ? `REJECT — ${company} · ${title}\nDo not apply. The blocked check below is a legal bar or a stated level bar, not a preference. (Best of ${routesTried} route(s); shown: ${routeLabel}.)`
      : verdict.status === "flag"
        ? `NEEDS A HUMAN CHECK — ${company} · ${title}\nOne or more gates could not be settled from the posting alone. (${routeLabel})`
        : `PASS — ${company} · ${title}\nClears every hard gate on the ${routeLabel}. Safe to research and draft.`;

  // When a basis without a sponsor requirement wins, the sponsor position is
  // never mentioned in the winning basis's reasons — so a founder weighing the
  // more secure HSM footing would not learn the employer is not a recognised
  // sponsor. State it explicitly rather than let the good news hide it.
  const sponsorNote =
    !gateProfile(route).sponsorRequired && match.verdict === "not-sponsor"
      ? `\n\nWorth knowing: this employer is absent from the IND recognised-sponsor register, ` +
        `so the HSM route is not open here today without them applying for recognition.`
      : "";

  const candidates =
    match.candidates.length > 0
      ? `\n\nRegister entries to disambiguate:\n${match.candidates.slice(0, 8).map((c) => `  · ${c}`).join("\n")}`
      : "";

  const nearDupeWarning =
    nearDuplicates.length > 0
      ? `\n\n⚠ POSSIBLE RE-POST of a role already in the tracker:\n${nearDuplicates
          .slice(0, 3)
          .map((d) => `  · "${d.title}" (${d.stage})`)
          .join("\n")}\nCheck before applying — the titles differ but the words are the same.`
      : "";

  // Each line carries its OWN mark. A flat list of reasons cannot say which
  // check failed, and reading position as importance is what made the brief
  // announce a passing sponsor check as the reason a role needed attention.
  const gateLines = verdict.gates
    .map((g) => `  ${gateMark(g.status)} ${g.gate}: ${g.evidence}`)
    .join("\n");

  return `${header}\n\n${gateLines}${sponsorNote}${candidates}${nearDupeWarning}`;
}
