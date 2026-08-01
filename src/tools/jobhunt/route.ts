/**
 * FounderOS — which market a posting belongs to
 * =============================================
 * `PostingRoute` describes the JOB. `PermitBasis` (permit-routes.ts) describes
 * PUSHKAR — what would make holding it lawful. Conflating the two has been a real
 * defect here before, so they stay separate types in separate files.
 *
 * Split out of extract.ts on 2026-08-01. Everything else in that module turns the
 * ad's PROSE into facts; this one starts from a fact the fetcher already had and
 * only falls back to prose when there wasn't one. Those are different jobs with
 * different failure modes, and the file budget agrees.
 *
 * THE ORDER OF PRECEDENCE IS THE WHOLE DESIGN: a fetched country beats the ad's
 * wording, always. The predecessor had no country at all and read "hybrid" as
 * proof of a Netherlands role — see country.ts for the nine Indian rows that
 * produced.
 */

import type { PostingCountry } from "./country.js";

/**
 * hsm — based in the Netherlands, needs a permit.
 * india — based in India, needs none: he is already there.
 * remote-contract — no local presence required, billed from India.
 * unclear — nobody has established where the work sits. An open question, and
 *   never a synonym for "probably fine".
 */
export type PostingRoute = "hsm" | "remote-contract" | "india" | "unclear";

const REMOTE_MARKER =
  /\b(fully remote|remote[- ]first|work from anywhere|100%\s*remote|freelance|freelancer|zzp|contractor|contracting|b2b|interim|detachering|zelfstandige)\b/i;

/**
 * Words that name a DESK ARRANGEMENT and nothing else.
 *
 * THIS SPLIT IS THE FIX. These used to sit in one regex with the immigration
 * terms below, and any match produced "hsm" — a claim that the job was in the
 * Netherlands. But "hybrid" is hybrid anywhere on earth. An Indian ad saying
 * "this is a hybrid role, three days in the office" was read as evidence of a
 * Dutch office, screened against Dutch immigration law, and stored with a Dutch
 * permit basis; nine production rows from the Indeed IN feed did exactly that.
 *
 * On their own these now establish NOTHING about geography — they leave the
 * route `unclear`, which is flagged and asked about rather than assumed.
 */
const ARRANGEMENT_MARKER = /\b(on[- ]?site|onsite|hybrid|hybride|office[- ]based)\b/i;

/**
 * Words that genuinely name a Dutch immigration context.
 *
 * "Kennismigrant" and "highly skilled migrant" ARE the permit. "Visa
 * sponsorship" and a relocation package mean the employer is moving someone
 * across a border and expects to. That is real evidence about the kind of role
 * this is, in a way that "we work three days in the office" is not — so these
 * may still settle the route where no country was fetched.
 */
const NL_SIGNAL =
  /\b(visa sponsorship|sponsorship available|highly skilled migrants?|kennismigrant(?:en)?|30%\s*ruling|ind recognised sponsor|relocation(?:\s+(?:package|support|assistance|budget))?|willing to relocate)\b/i;

/**
 * Which market a posting belongs to, country first.
 *
 * NL  — a Dutch role. The ad's wording still decides whether it is a relocation
 *       (permit-bound) or a contract that could be billed from India.
 * IN  — an Indian role. There is nothing further to decide: he lives there, and
 *       no permit, sponsor or salary criterion is in play. Note that the ad's
 *       wording is NOT consulted at all here — "hybrid" in an Indian ad means
 *       hybrid in Bangalore, and reading it as evidence of a Dutch office is
 *       precisely the bug this argument exists to prevent.
 * other — somewhere neither market covers. He cannot be hired locally in
 *       Colombia, so the only basis that could carry it is a remote contract.
 *       The Location gate then states the country and asks for confirmation;
 *       narrowing the basis is not the same as approving the role.
 * unknown — nothing was fetched, so the prose is all there is. `unclear` is a
 *       real answer here and gets flagged downstream, never quietly passed.
 */
export function extractRoute(text: string, country: PostingCountry = "unknown"): PostingRoute {
  if (country === "IN") return "india";

  const remote = REMOTE_MARKER.test(text);
  const deskBound = ARRANGEMENT_MARKER.test(text);

  if (country === "NL") return remote && !deskBound ? "remote-contract" : "hsm";
  if (country === "other") return "remote-contract";

  // No country was fetched, so the ad's wording is all there is — and only the
  // wording that actually implies a place is allowed to settle it. A desk
  // arrangement alone leaves this `unclear` on purpose: `unclear` is asked
  // about, whereas a wrong "hsm" is acted on.
  if (remote && !deskBound) return "remote-contract";
  if (NL_SIGNAL.test(text) && !remote) return "hsm";
  return "unclear";
}
