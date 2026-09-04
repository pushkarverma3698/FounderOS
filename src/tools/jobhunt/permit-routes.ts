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
import { getProfile, type JobSearchProfile } from "./profile-config.js";

export type PermitBasis = "hsm" | "partner-permit" | "remote-contract" | "india-local" | "zoekjaar";

/** Every basis this module knows how to gate. Used to reject unknown bases loudly. */
export const KNOWN_PERMIT_BASES: readonly PermitBasis[] = [
  "hsm",
  "partner-permit",
  "remote-contract",
  "india-local",
  "zoekjaar",
];

export function isKnownPermitBasis(value: string): value is PermitBasis {
  return (KNOWN_PERMIT_BASES as readonly string[]).includes(value);
}

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
const NL_BASES: readonly PermitBasis[] = ["hsm", "partner-permit", "zoekjaar"];

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
 *
 * `zoekjaar` is absent for the same reason and it is the newer half of the rule.
 * It clears both the sponsor gate and the salary floor, so it is now the most
 * permissive Dutch basis in the set — and it is only lawful for a role that is
 * actually IN the Netherlands. Letting it carry an unlocated posting would put a
 * Bogotá role back into APPLY TODAY, this time on an orientation-year permit.
 */
const UNCLEAR_BASES: readonly PermitBasis[] = ["hsm", "partner-permit", "remote-contract"];

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
   * ORIENTATION YEAR (zoekjaar) — confirmed by the founder about his wife,
   * 2026-09-04: "she's on zoekjaar".
   *
   * This is the most permissive Dutch basis there is, and it is permissive as a
   * matter of law rather than as a modelling convenience. A zoekjaar holder has
   * free access to the Dutch labour market for the duration of the permit: the
   * employer needs no recognised-sponsor status, needs no work permit, and no
   * IND salary criterion attaches. Screening her under `hsm` instead — which is
   * what this branch did until today — applied the recognised-sponsor register
   * to every Dutch employer and rejected the large majority of a market she can
   * lawfully work in right now. Those rejections would have been invisible.
   *
   * WHAT IT DOES NOT DO: it does not last. The orientation year is time-boxed
   * and non-renewable, so a role reachable ONLY on this basis is a role that
   * ends when the permit does. That is why `basesForPosting` screens an NL role
   * under `hsm` as well for this profile rather than instead of it — a row that
   * clears both is worth more than one that clears only this, and the founder
   * sees which of the two carried it in the route label.
   */
  zoekjaar: {
    sponsorRequired: false,
    salaryFloorApplies: false,
    payReference: "eur",
    dutchLanguageApplies: true,
    label: "orientation year (zoekjaar)",
    basis:
      "Orientation year (zoekjaar) — free access to the Dutch labour market while the permit " +
      "runs: no recognised sponsor and no IND salary criterion apply. Time-boxed and " +
      "non-renewable, so check whether the employer could also sponsor an HSM permit after it.",
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

/**
 * The gate to record when `basesForPosting` returns a basis this profile does
 * not actually hold live (a DEFINITE route matched none of the profile's
 * bases). A single reject, not the normal sponsor/salary/language set — none
 * of those gates mean anything for a basis the candidate doesn't have.
 *
 * Kept here rather than inline in screen.ts's outcomes loop so that file's
 * per-route branch stays a one-line call under the LOC budget; the gate
 * shape itself belongs beside the PROFILES it is describing a mismatch with.
 */
export function nonLiveBasisRejectGate(
  route: PermitBasis,
  profile: JobSearchProfile,
): { gate: string; status: "reject"; evidence: string } {
  return {
    gate: "Basis",
    status: "reject",
    evidence:
      `This role's market (${routeLabel(route)}) is not one you have a legal basis for — ` +
      `your declared bases are ${profile.permitBases.join(", ")}.`,
  };
}

/**
 * The founder-facing name of a stored `route`, resolved AT RENDER TIME.
 *
 * Deliberately not read from the row's stored gate evidence, and the distinction
 * is the whole point. Gate evidence is a record of what was decided about a
 * POSTING when it was screened, and freezing it is correct — re-deriving it
 * later would let today's rules rewrite yesterday's verdict.
 *
 * A permit basis is not that. It is a fact about the PERSON, and it changes: the
 * partner permit went from "confirmed" to "applied for, awaiting decision"
 * between one screening run and the next. A row screened before that change
 * would otherwise keep telling the founder his right to work is settled, on a
 * shortlist he is about to act on. Rendering it live means the whole queue
 * corrects the moment the fact does, instead of over the 24 hours it takes the
 * old rows to age out.
 *
 * Unknown values pass through unchanged: a legacy or hand-entered route is
 * printed as it was stored rather than silently relabelled.
 */
export function routeLabel(route: string): string {
  return route in PROFILES ? PROFILES[route as PermitBasis].label : route;
}

/**
 * Whether a basis is one THIS candidate actually holds.
 *
 * Reads `profile.permitBases`, which is a declared fact about a person and is
 * never inferred from documents. Getting it wrong in the permissive direction
 * spends applications on roles the candidate cannot hold; in the restrictive
 * direction it silently discards roles they can. Change a profile's list only on
 * the founder's say-so.
 */
export function isLiveBasis(basis: PermitBasis, profile: JobSearchProfile = getProfile()): boolean {
  return profile.permitBases.includes(basis);
}

/**
 * Which bases to screen a posting under.
 *
 * A posting is screened under EVERY basis that could lawfully carry it, and the
 * best outcome wins (see `bestOutcome` in screen.ts). Screening under one basis
 * and calling it the answer is what produced confident rejections of roles that
 * were reachable another way.
 */
export function basesForPosting(route: PostingRoute, profile: JobSearchProfile = getProfile()): PermitBasis[] {
  const isDefiniteRoute = route !== "unclear";
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

  const live = candidates.filter((b) => isLiveBasis(b, profile));
  if (live.length > 0) return live;

  // A DEFINITE route (the fetcher established the market — hsm/india/remote)
  // that matches none of this profile's live bases must NOT fall back to
  // "whatever basis this profile happens to hold" — that basis has nothing to
  // do with the posting's actual, known market. Found live, 2026-09-04: an
  // Wife-nl-finance profile (permitBases zoekjaar+hsm, no india-local) hit a
  // Bangalore-country="IN" posting, and the old fallback below carried it as
  // "zoekjaar" — a Dutch orientation-year permit — with evidence text reading
  // "free access to the Dutch labour market" on a role that is not in the
  // Dutch labour market. Returning the untouched (non-live) candidate here
  // instead lets the caller (screen.ts) detect the mismatch via `isLiveBasis`
  // and reject honestly, rather than silently relabelling a definite finding.
  if (isDefiniteRoute) return [...candidates];

  // The genuinely ambiguous case: `route === "unclear"` and none of UNCLEAR_BASES
  // is live for this profile. Never return nothing — a posting screened under no
  // basis would be recorded with no verdict at all, which reads as "considered
  // and found wanting" when in fact nothing looked at it. The fallback is the
  // profile's OWN first declared basis so a non-Dutch profile is never silently
  // judged by Dutch law, and it degrades to HSM — the strictest gates in the
  // set — when that list is empty or names a basis this module has no gate
  // profile for. Either way the failure direction is a visible reject, not a
  // silent pass.
  const declared = profile.permitBases.find(isKnownPermitBasis);
  return [declared ?? "hsm"];
}
