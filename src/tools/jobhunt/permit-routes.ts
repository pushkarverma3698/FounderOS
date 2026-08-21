/**
 * Permit bases and their gate profiles
 * ====================================
 * WHICH LEGAL BASIS lets Pushkar hold a role — as distinct from what the posting
 * is. Those are two different things and conflating them was a real defect:
 *
 *   · `PostingRoute` (extract.ts) describes the JOB — a remote contract, or a
 *     role based in the Netherlands.
 *   · `PermitBasis` (here) describes PUSHKAR — what makes holding it lawful.
 *
 * One Netherlands-based role can be lawful under EITHER the highly skilled
 * migrant scheme OR a partner permit, and those carry completely different gates.
 * The previous design had only the HSM basis, so it applied the sponsor gate and
 * the IND salary floor to every Dutch posting and rejected roles that were
 * perfectly lawful on the other basis. Those rejections were invisible — a
 * rejected posting produces no signal that it was rejected wrongly.
 *
 * WHY THE FLOOR IS NOT A TUNABLE NUMBER: under the HSM basis the salary criterion
 * is a legal condition of the permit, not a preference. Lowering it does not
 * create opportunities; it manufactures applications that cannot lawfully
 * succeed, and their failure arrives weeks later as silence. So the floor stays,
 * and breadth comes from screening the OTHER bases — which genuinely do not have
 * one — rather than from softening a legal constraint.
 */

import type { PostingRoute } from "./extract.js";

export type PermitBasis = "hsm" | "partner-permit" | "remote-contract" | "india-local";

/**
 * The bases Pushkar can actually use, confirmed by him on 2026-07-31, extended
 * with the Indian local market on 2026-08-01 ("we need dutch and indian both").
 *
 * This is a declared fact about a person, not a derived one. It is not inferred
 * from documents and must not be: getting it wrong in the permissive direction
 * spends applications on roles he cannot hold, and in the restrictive direction
 * silently discards roles he can. Change it only on his say-so.
 */
export const LIVE_PERMIT_BASES: readonly PermitBasis[] = [
  "hsm",
  "partner-permit",
  "remote-contract",
  "india-local",
];

/** Bases usable for a role based in the Netherlands (a remote contract is not one). */
const NL_BASES: readonly PermitBasis[] = ["hsm", "partner-permit"];

/**
 * The bases still open when nobody has established WHERE the job is.
 *
 * `india-local` is deliberately absent, and this is the single most important
 * line in the file. It has the fewest gates of any basis — no register lookup,
 * no permit criterion, no Dutch requirement — so including it here would make it
 * win every tie on an unreadable posting, and "we don't know where this is"
 * would once again resolve to the most permissive answer available. That exact
 * mechanism put a Bogotá role into APPLY TODAY on a Dutch partner permit six
 * days ago.
 *
 * Being in India is a POSITIVE FINDING from the fetcher (country === "IN"),
 * never a fallback for ignorance.
 */
const UNCLEAR_BASES: readonly PermitBasis[] = [...NL_BASES, "remote-contract"];

export interface GateProfile {
  /** Whether the employer must appear in the IND recognised-sponsor register. */
  readonly sponsorRequired: boolean;
  /** Whether the IND salary criterion is a legal condition under this basis. */
  readonly salaryFloorApplies: boolean;
  /**
   * Which yardstick the pay gate uses.
   *
   * Not cosmetic. A rupee figure screened against a euro reference is not
   * approximately right — ₹15,00,000 is not €1,500,000 — and the whole point of
   * running two markets is that each is judged by its own numbers.
   */
  readonly payReference: "eur" | "inr";
  /**
   * Whether a Dutch-language requirement can bar this role.
   *
   * False for an Indian local hire, where the gate would print "no Dutch-language
   * requirement mentioned" on a Bangalore posting — a cleared check about a
   * language nobody asked for, which is noise dressed as information.
   */
  readonly dutchLanguageApplies: boolean;
  /** Short name used in the founder-facing verdict. */
  readonly label: string;
  /** Why these gates do or do not apply — quoted into the evidence line. */
  readonly basis: string;
}

const PROFILES: Record<PermitBasis, GateProfile> = {
  hsm: {
    sponsorRequired: true,
    salaryFloorApplies: true,
    payReference: "eur",
    dutchLanguageApplies: true,
    label: "sponsorship route",
    basis:
      "Highly skilled migrant: the employer must be an IND recognised sponsor and must pay " +
      "at least the salary criterion. Both are legal conditions of the permit.",
  },
  /**
   * APPLIED FOR, DECISION PENDING — founder, 2026-08-21: "for partner permit
   * screen those jobs also as it is currently applied and waiting for the
   * decision."
   *
   * So the screening is unchanged: these roles stay in, because a decision that
   * lands next month is worth having a shortlist ready for. What changed is that
   * the words say so. `basesForPosting` screens an NL role under BOTH bases and
   * `bestOutcome` keeps the better one, and this basis needs no sponsor and has
   * no salary floor — so it wins every Dutch row it touches, and before this the
   * founder read "partner-permit route · neither gate can void the role" as a
   * settled fact about a permit he does not hold yet.
   *
   * That is the difference between a shortlist and a shortlist he can trust: a
   * row carried only by this basis is an application he can send, on a right to
   * work that is not yet granted.
   */
  "partner-permit": {
    sponsorRequired: false,
    salaryFloorApplies: false,
    payReference: "eur",
    dutchLanguageApplies: true,
    label: "partner-permit route (application pending)",
    basis:
      "Partner permit — APPLIED FOR, awaiting the IND decision. Once granted it gives free " +
      "access to the labour market, so no recognised sponsor and no IND salary criterion " +
      "apply. Until then this role is reachable only if that decision comes through.",
  },
  "remote-contract": {
    sponsorRequired: false,
    salaryFloorApplies: false,
    payReference: "eur",
    dutchLanguageApplies: true,
    label: "remote-contract route",
    basis: "Remote contract worked from India — no Dutch permit is involved.",
  },
  /**
   * The second market, live since 2026-08-01.
   *
   * Nothing legal stands between him and an Indian role: he is in India and needs
   * no permit, no sponsor and no salary criterion to hold one. That makes this
   * the most permissive basis in the set, which is exactly why `basesForPosting`
   * refuses to reach for it unless the fetcher POSITIVELY established the country
   * — see UNCLEAR_BASES.
   */
  "india-local": {
    sponsorRequired: false,
    salaryFloorApplies: false,
    payReference: "inr",
    dutchLanguageApplies: false,
    label: "India, local hire",
    basis:
      "Based in India, where you already live and already have the right to work. No permit, " +
      "no sponsor and no salary criterion is involved — only whether the role and the pay " +
      "are worth taking.",
  },
};

export function gateProfile(basis: PermitBasis): GateProfile {
  return PROFILES[basis];
}

export function isLiveBasis(basis: PermitBasis): boolean {
  return LIVE_PERMIT_BASES.includes(basis);
}

/**
 * Which bases to screen a posting under.
 *
 * A posting is screened under EVERY basis that could lawfully carry it, and the
 * best outcome wins (see `bestOutcome` in screen.ts). Screening under one basis
 * and calling it the answer is what produced confident rejections of roles that
 * were reachable another way.
 */
export function basesForPosting(route: PostingRoute): PermitBasis[] {
  const candidates: readonly PermitBasis[] =
    route === "remote-contract"
      ? ["remote-contract"]
      : route === "hsm"
        ? NL_BASES
        : route === "india"
          ? // An Indian role is screened ONLY as an Indian local hire. Adding the
            // remote-contract basis alongside it would put a euro pay yardstick
            // beside a rupee one on the same posting and let the kinder of the two
            // win — the two markets are judged by their own numbers or not at all.
            ["india-local"]
          : UNCLEAR_BASES;

  const live = candidates.filter(isLiveBasis);

  // Never return nothing: a posting screened under no basis would be recorded
  // with no verdict at all, which reads as "considered and found wanting" when
  // in fact nothing looked at it. Falling back to HSM keeps the strictest gates
  // in play, so the failure direction is a visible reject, not a silent pass.
  return live.length > 0 ? live : ["hsm"];
}
