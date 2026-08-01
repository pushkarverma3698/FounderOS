/**
 * FounderOS — the gate builders that do not read the posting's numbers
 * ====================================================================
 * Three pure functions that turn a fact about a posting into a `Gate`: is the
 * body long enough to judge at all, is the permit basis actually established,
 * and can this employer lawfully sponsor.
 *
 * Split out of `screen.ts` on 2026-08-01 when that file crossed the 400-line
 * budget. Nothing about the behaviour moved with them — `screen.ts` re-exports
 * all three, so every existing import keeps working, and there is still exactly
 * one implementation of each gate. A second implementation is the failure this
 * codebase guards hardest against: both paths would keep returning confident
 * verdicts while silently disagreeing.
 *
 * The salary, language and experience gates live in `filters.ts` and
 * `experience.ts` because they parse the ad's text. These three do not.
 */

import type { SponsorMatch } from "./sponsor-match.js";
import type { registerStaleness } from "./sponsor-registry.js";
import type { PostingRoute } from "./extract.js";
import type { GateProfile } from "./permit-routes.js";
import type { ScreenStatus } from "./filters.js";
import type { Gate } from "./gates.js";

/**
 * Below this many characters, the body is a teaser rather than a job ad.
 *
 * The salary, language and experience gates all read the body, so a 200-character
 * stub produces three confident verdicts from evidence that was never fetched.
 * The posting is still SCREENED and still STORED — it is flagged instead, with
 * the reason, so a thin feed reads as a thin feed rather than as a quiet market.
 *
 * Deliberately the same number as `MIN_DESCRIPTION_CHARS` in indeed-source.ts,
 * which drops thin rows before they ever reach here. Two different thresholds
 * for "too thin to judge" would mean a body Indeed considered unusable arriving
 * from the ATS feed and being screened as if it were complete. Not imported from
 * there — a pure gate must not depend on a network module — so the equality is
 * asserted in tests/unit/jobhunt/cost-ledger.test.ts instead.
 */
export const THIN_BODY_CHARS = 400;

/** Flags a body too short to have carried the evidence the other gates read. */
export function postingGate(description: string): Gate | null {
  if (description.trim().length >= THIN_BODY_CHARS) return null;
  return {
    gate: "Posting",
    status: "flag",
    evidence:
      `Only ${description.trim().length} characters of job ad reached us, so the ` +
      `salary, language and experience checks below had almost nothing to read. ` +
      `Open the link before trusting any of them.`,
  };
}

/** The plain-language pass line for a basis that needs no register lookup. */
export function basisGate(profile: GateProfile): Gate {
  return { gate: "Basis", status: "pass", evidence: profile.basis };
}

/**
 * Flags a posting that never says where the work actually is.
 *
 * WHY THIS IS A SHARED GATE AND NOT PART OF THE BASIS. Where a job sits is a
 * fact about the POSTING, exactly like whether enough of the ad arrived. Every
 * permit basis is then a claim about that same fact, so the uncertainty has to
 * be reported once, for all of them — not folded into whichever basis happened
 * to win.
 *
 * THE DEFECT THAT PRODUCED IT (live prod sweep, 2026-08-01). `basesForPosting`
 * screens an `unclear` posting under every basis and `bestOutcome` keeps the
 * best. The partner permit has the fewest gates — no register lookup, no IND
 * salary floor — so it passed unconditionally and won every time a location
 * could not be read. The fallback for NOT KNOWING was the most PERMISSIVE basis
 * available. The founder was told to apply today to a role in Bogotá on the
 * strength of a Dutch permit; 17 of 34 stored rows had resolved that way,
 * including employers in Brazil, the United States and India.
 *
 * A flag, never a reject: the role keeps its place in the pipeline with the
 * reason stored and shown, and lands one question away instead of in APPLY
 * TODAY. Discarding it would be worse — a filtered-out row and an empty market
 * look identical from outside.
 */
export function locationGate(postingRoute: PostingRoute): Gate | null {
  if (postingRoute !== "unclear") return null;
  return {
    gate: "Location",
    status: "flag",
    evidence:
      "The posting never says where the work is based, so every permit basis below " +
      "is an assumption rather than a finding. Ask where the role sits before " +
      "applying — the answer decides whether it is reachable at all.",
  };
}

export function sponsorGate(match: SponsorMatch, stale: ReturnType<typeof registerStaleness>): Gate {
  // A stale register cannot invent a sponsor, so a positive stays valid. A
  // NEGATIVE from a stale file is a hard reject of a company that may have been
  // recognised since — downgrade it to a human check rather than a silent drop.
  if (match.verdict === "not-sponsor" && stale.stale) {
    return {
      gate: "Sponsor",
      status: "flag",
      evidence: `${match.evidence} BUT this cannot be trusted: ${stale.note}`,
    };
  }

  // Absence from the register FLAGS rather than rejects (founder decision,
  // 2026-07-31). Recognition costs an employer roughly €4,500 and about four
  // weeks, and companies do take it on for someone they want — so "not a sponsor
  // today" is not "cannot hire you". Rejecting made that permanently invisible;
  // a flag keeps it a decision Pushkar gets to make.
  if (match.verdict === "not-sponsor") {
    return {
      gate: "Sponsor",
      status: "flag",
      evidence:
        `${match.evidence} They could still become one (~€4,500, ~4 weeks) — worth asking ` +
        `if the role is otherwise strong, rather than assuming no.`,
    };
  }

  const status: ScreenStatus = match.verdict === "sponsor" ? "pass" : "flag";
  return { gate: "Sponsor", status, evidence: match.evidence };
}
