/**
 * FounderOS — who a remote posting is open to
 * ===========================================
 * A posting whose country is `unknown` (bare "Remote", a blank location, "EU",
 * "EMEA") names no place, but it is not always silent about WHO may take it.
 * Prod audit 2026-11-03..10: 60 of 277 passed or flagged roles had country
 * `unknown`, and the Location gate stayed quiet on any of them whose ad said
 * "contractor" or "remote-first". A US-only role passed on a basis nobody had
 * established.
 *
 * Two readings matter, both from facts already on the posting (never a prompt):
 *   · `us-only` — the body restricts the work to US residents or US authorization.
 *   · `contract` — the ad offers a freelance/B2B/interim ENGAGEMENT. That is billed
 *     from wherever the contractor is, so no employer-side country is in question.
 *     Plain "fully remote" or "remote-first" is NOT this: an employer may still
 *     decline to hire in India.
 *   · `eu-region` — the location names a European REGION (EU, EMEA, Europe). That
 *     is a remote-contract basis, not a country: it works for him only if the
 *     employer will contract someone in India, so it is flagged with that reason.
 *
 * Pure: no I/O, no model.
 */

import type { PostingCountry } from "./country.js";
import type { PostingRoute } from "./route.js";

export type RemoteScope = "us-only" | "eu-region" | "contract" | "unscoped";

/** Wording that restricts a role to the United States. Whole phrases, so "join us" never matches. */
const US_ONLY_BODY = new RegExp(
  [
    String.raw`\b(?:u\.?s\.?a?|united states)[ -]only\b`,
    String.raw`\bonly (?:open |available )?(?:to|for) (?:candidates |residents |applicants )?(?:based |located |living )?in the (?:u\.?s\.?a?|united states)\b`,
    String.raw`\bmust (?:be (?:based|located|living|resident)|reside|live|work) (?:and work )?(?:in|within) the (?:u\.?s\.?a?|united states)\b`,
    String.raw`\b(?:authori[sz]ed|eligible|legally entitled) to work in the (?:u\.?s\.?a?|united states)\b`,
    String.raw`\bu\.?s\.?[ -]based (?:candidates|applicants|employees)\b`,
    String.raw`\bremote (?:within|in) the (?:u\.?s\.?a?|united states)\b`,
    String.raw`\bcandidates (?:must|should) be based in the (?:u\.?s\.?a?|united states)\b`,
  ].join("|"),
  "i",
);

/** A European region used as a location. "Remote EU", "EMEA", "Remote, Europe". */
const EU_REGION_LOCATION = /\b(?:eu|emea|europe|european union)\b/i;

const CONTRACT_BODY =
  /\b(?:freelance|freelancer|zzp|b2b|interim|detachering|zelfstandige|independent contractor|contract role|contract basis)\b/i;

export function remoteScope(location: string, description: string): RemoteScope {
  if (US_ONLY_BODY.test(description)) return "us-only";
  if (EU_REGION_LOCATION.test(location)) return "eu-region";
  if (CONTRACT_BODY.test(description)) return "contract";
  return "unscoped";
}

/**
 * The route to screen under once the scope is known.
 *
 * An `unclear` route is screened under HSM, the partner permit and a remote
 * contract, and the partner permit (fewest gates) wins. A role that is US-only
 * or EU-region-only cannot be carried by a Dutch permit that was never asked
 * for, so it is screened as a remote contract — the one basis that could.
 */
export function routeForScope(route: PostingRoute, country: PostingCountry, scope: RemoteScope): PostingRoute {
  if (country !== "unknown" || route !== "unclear") return route;
  return scope === "unscoped" ? route : "remote-contract";
}
