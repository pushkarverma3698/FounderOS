/**
 * FounderOS — market definitions shared between candidate profiles
 * ================================================================
 * A `CountryConfig` answers one question — "does this posting's location string
 * name this market?" — and the answer is a property of the COUNTRY, not of the
 * candidate. Two profiles targeting India have no reason to recognise different
 * Indian cities, and when they do, the one with the shorter list silently sees a
 * smaller market than the other for no stated reason.
 *
 * So the Indian market lives here, once, and both profiles import it (founder
 * directive 2026-09-08: "Tashi will also apply in india"). Lifted verbatim from
 * `profile-config.ts`, where it was inline on the founder's profile — every city
 * is unchanged, which is what `tests/unit/jobhunt/posting-country.test.ts` pins.
 *
 * THE NETHERLANDS IS DELIBERATELY NOT HERE. The two profiles' Dutch city lists
 * genuinely differ today, and collapsing them would widen one candidate's market
 * as a side effect of a refactor nobody asked for. If they should be the same
 * list, that is a decision to take on its own.
 *
 * Data only — no logic, no I/O. `country.ts` is what reads it.
 */

import type { CountryConfig } from "../profile-config.js";

/**
 * India, as a location-matching market.
 *
 * The city list is wider than the metro tier on purpose: `countryFromLocation`
 * falls back to a hardcoded list in `country.ts` that is wider still, but that
 * fallback only speaks for markets a profile actually declares — so a profile
 * that names India gets both, and one that does not gets neither.
 */
export const INDIA_MARKET: CountryConfig = {
  code: "IN",
  names: ["india", "bharat"],
  cities: [
    "bengaluru", "bangalore", "hyderabad", "pune", "mumbai", "chennai", "new delhi",
    "delhi", "noida", "gurgaon", "gurugram", "kolkata", "ahmedabad", "jaipur", "indore",
    "chandigarh", "kochi", "coimbatore", "thiruvananthapuram", "bhubaneswar", "lucknow",
    "varanasi", "bareilly", "mysore", "mysuru", "nashik", "tirupati", "vadodara", "surat",
    "nagpur", "visakhapatnam", "vizag", "trivandrum", "mohali", "bhopal", "rajkot",
    "faridabad", "ghaziabad", "thane", "navi mumbai", "whitefield", "hinjewadi",
    "madurai", "tiruchirappalli", "guwahati", "patna", "kanpur", "dehradun", "udaipur",
    "vijayawada", "raipur", "ludhiana", "amritsar", "agra", "meerut", "gandhinagar",
    "hubli", "warangal", "vellore", "jodhpur", "maharashtra", "karnataka", "tamil nadu",
    "telangana", "uttar pradesh", "gujarat", "haryana", "west bengal", "kerala",
    "rajasthan", "andhra pradesh", "madhya pradesh", "odisha", "delhi ncr",
  ],
  atsLocations: ["India"],
};
