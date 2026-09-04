/**
 * FounderOS — where a posting actually is
 * =======================================
 * The campaign runs in TWO markets — the Netherlands (relocation, permit-bound)
 * and India (local hire, no permit at all) — and almost every gate downstream
 * branches on which one a posting belongs to. So this answer has to be a FACT,
 * and until 2026-08-01 it was an inference.
 *
 * WHAT WENT WRONG. `extractRoute` returned `hsm` — "Netherlands, highly skilled
 * migrant" — whenever the ad said "on-site", "hybrid" or "office-based". Not one
 * of those words names a country. An Indian ad saying "hybrid" was therefore
 * filed as a Dutch role, screened against Dutch immigration law, and stored with
 * a Dutch permit basis; nine rows from the Indeed **IN** feed sat in production
 * exactly that way. Meanwhile a Colombian posting whose location could not be
 * read reached rank 2 of APPLY TODAY on the strength of a Dutch partner permit.
 *
 * WHY THE FIX IS NOT A BETTER REGEX. The fetcher already knew. It had queried
 * Indeed IN rather than Indeed NL; the ATS feed returns `locations_derived` on
 * every posting. That knowledge was discarded on the way into the screener so
 * the screener could re-derive it from prose — replacing a fact with a guess.
 * The country now travels WITH the posting, and the ad's wording is consulted
 * only where nothing was fetched.
 *
 * `other` and `unknown` are deliberately different answers. "This job is in
 * Colombia" is a finding that narrows the lawful bases to one; "we could not
 * tell where this job is" is an open question that has to be asked. Collapsing
 * them is how the Bogotá row looked identical to a Dutch one.
 *
 * Pure: no I/O, no model, no network.
 */

import { getProfile, type JobSearchProfile, type CountryConfig } from "./profile-config.js";

/** NL and IN are default markets; any ISO alpha-2 or string is supported. `other` is a place; `unknown` is not. */
export type PostingCountry = string;

/**
 * Strings that occupy the location field without naming a place.
 *
 * These must read as `unknown`, not as `other`. "Remote" is the absence of a
 * location, and treating it as a third country would narrow the lawful bases on
 * the strength of a word that says nothing about geography at all.
 */
const NON_PLACE = new Set([
  "remote",
  "remote worldwide",
  "worldwide",
  "anywhere",
  "work from anywhere",
  "global",
  "globally",
  "international",
  "various",
  "multiple locations",
  "emea",
  "apac",
  "europe",
  "eu",
  "n/a",
  "na",
  "unknown",
  "tbd",
]);

/**
 * Country names, in the spellings the two feeds actually emit.
 *
 * Matched on WORD BOUNDARIES, which is load-bearing: a substring test files
 * every Indianapolis role as an Indian local hire and then applies a rupee pay
 * yardstick to a dollar salary. `\bindia\b` does not match "Indiana".
 *
 * The two-letter ISO codes are deliberately absent. A feed's location string
 * spells countries out ("Amsterdam, North Holland, Netherlands"), and `\bin\b`
 * would match the preposition in "Remote in Europe" and file a European contract
 * role as an Indian local hire. Where a code IS the source of truth — the Indeed
 * query knows it asked for NL or IN — it is stamped on the posting directly and
 * never round-trips through this function.
 */
const NL_NAMES = ["netherlands", "the netherlands", "nederland", "holland"];
const IN_NAMES = ["india", "bharat"];

/**
 * Hub cities, for the rows that arrive with a city and no country.
 *
 * The ATS feed populates `cities_derived` when `locations_derived` is empty, so
 * a posting can reach us as the bare string "Bangalore". Falling through to
 * `unknown` there would put a plainly Indian role into the "we don't know where
 * this is" queue and make the founder answer a question the feed already knew.
 *
 * Only unambiguous city names appear. A city that is also a common word, or that
 * exists in several countries, stays out — a wrong country here is worse than an
 * unknown one, because `unknown` asks and a wrong answer asserts.
 */
const NL_CITIES = [
  "amsterdam",
  "rotterdam",
  "utrecht",
  "eindhoven",
  "den haag",
  "the hague",
  "groningen",
  "tilburg",
  "almere",
  "breda",
  "nijmegen",
  "haarlem",
  "arnhem",
  "amersfoort",
  "delft",
  "leiden",
  "zwolle",
  "maastricht",
  "hilversum",
  // Added 2026-08-20. "Schiphol-Rijk" was being filed as a country outside both
  // markets — an office park fifteen minutes from Amsterdam. The rest are the
  // other Dutch employment centres, added at the same time so the next one is
  // not found the same way. `\bschiphol\b` matches "Schiphol-Rijk" because a
  // hyphen is a word boundary.
  "schiphol",
  "hoofddorp",
  "amstelveen",
  "diemen",
  "zaandam",
  "purmerend",
  "hoorn",
  "alkmaar",
  "lelystad",
  "apeldoorn",
  "deventer",
  "enschede",
  "hengelo",
  "zutphen",
  "doetinchem",
  "harderwijk",
  "leeuwarden",
  "drachten",
  "sneek",
  "heerenveen",
  "assen",
  "emmen",
  "meppel",
  "hoogeveen",
  "zoetermeer",
  "rijswijk",
  "delfgauw",
  "wassenaar",
  "katwijk",
  "noordwijk",
  "dordrecht",
  "gouda",
  "schiedam",
  "vlaardingen",
  "barendrecht",
  "gorinchem",
  "nieuwegein",
  "houten",
  "woerden",
  "veenendaal",
  "wageningen",
  "zeist",
  "soest",
  "den bosch",
  "'s-hertogenbosch",
  "hertogenbosch",
  "helmond",
  "veldhoven",
  "oosterhout",
  "roosendaal",
  "bergen op zoom",
  "venlo",
  "roermond",
  "sittard",
  "heerlen",
  "waalwijk",
  "tiel",
  // Provinces. "Holland" is already an NL_NAME, so Noord-/Zuid-Holland need no
  // entry. Limburg is DELIBERATELY absent: it is a province of Belgium too, and
  // "Hasselt, Limburg, Belgium" appeared in the live sample — a wrong country is
  // worse than an unknown one.
  "noord-brabant",
  "north brabant",
  "gelderland",
  "overijssel",
  "friesland",
  "drenthe",
  "flevoland",
];

const IN_CITIES = [
  "bengaluru",
  "bangalore",
  "hyderabad",
  "pune",
  "mumbai",
  "chennai",
  "new delhi",
  "delhi",
  "noida",
  "gurgaon",
  "gurugram",
  "kolkata",
  "ahmedabad",
  "jaipur",
  "indore",
  "chandigarh",
  "kochi",
  "coimbatore",
  "thiruvananthapuram",
  "bhubaneswar",
  // Added 2026-08-20 from measurement, not from a list: in one 90-board sample
  // these eight spellings — Lucknow, Varanasi, Bareilly, Mysore, Nashik,
  // Tirupati, Vadodara, Surat — carried 15 postings that were filed as "a
  // country outside both your markets" and dropped before screening. India is
  // the market he actually lives in.
  "lucknow",
  "varanasi",
  "bareilly",
  "mysore",
  "mysuru",
  "nashik",
  "tirupati",
  "vadodara",
  "surat",
  "nagpur",
  "visakhapatnam",
  "vizag",
  "trivandrum",
  "mohali",
  "bhopal",
  "rajkot",
  "faridabad",
  "ghaziabad",
  "thane",
  "navi mumbai",
  "whitefield",
  "hinjewadi",
  "madurai",
  "tiruchirappalli",
  "guwahati",
  "patna",
  "kanpur",
  "dehradun",
  "udaipur",
  "vijayawada",
  "raipur",
  "ludhiana",
  "amritsar",
  "agra",
  "meerut",
  "gandhinagar",
  "hubli",
  "warangal",
  "vellore",
  "jodhpur",
  // States and regions, which Indian feeds append far more often than Dutch
  // ones do ("Lucknow, Uttar Pradesh"). Punjab is DELIBERATELY absent — it is a
  // province of Pakistan under the same name. So is Salem, which is a city in
  // Oregon and in Massachusetts before it is one in Tamil Nadu.
  "maharashtra",
  "karnataka",
  "tamil nadu",
  "telangana",
  "uttar pradesh",
  "gujarat",
  "haryana",
  "west bengal",
  "kerala",
  "rajasthan",
  "andhra pradesh",
  "madhya pradesh",
  "odisha",
  "delhi ncr",
];

/** Word-boundary test for any phrase in the list. */
function mentionsAny(haystack: string, phrases: readonly string[]): boolean {
  return phrases.some((phrase) => {
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`, "i").test(haystack);
  });
}

/**
 * Read a country out of a feed's location string.
 *
 * The two markets are checked before the fallback, and the fallback is `other`
 * rather than `unknown`: a string that names somewhere, is not the Netherlands
 * and is not India, HAS told us something — that neither market applies — and
 * that is exactly the finding the Bogotá row needed and did not get.
 */
export function countryFromLocation(
  location: string,
  profile: JobSearchProfile = getProfile(),
): PostingCountry {
  const text = location.trim();
  if (text.length === 0) return "unknown";

  const lower = text.toLowerCase();

  // Check direct country code match
  for (const c of profile.targetCountries) {
    if (lower === c.code.toLowerCase()) return c.code;
  }

  if (NON_PLACE.has(lower)) return "unknown";

  // Check each configured target country in the profile
  for (const c of profile.targetCountries) {
    if (mentionsAny(text, c.names) || mentionsAny(text, c.cities)) return c.code;
  }

  // Fallback to hardcoded NL/IN lists if profile target countries did not catch it
  if (mentionsAny(text, NL_NAMES) || mentionsAny(text, NL_CITIES)) return "NL";
  if (mentionsAny(text, IN_NAMES) || mentionsAny(text, IN_CITIES)) return "IN";
  if (namesNoPlace(lower)) return "unknown";
  return "other";
}

/**
 * Words that can fill a location field without narrowing where a job is.
 *
 * Single tokens, because this is applied per-word to strings the exact-match
 * NON_PLACE set cannot cover. "united"/"states"/"kingdom" are absent on
 * purpose: those DO name a country, and reading "Remote, United States" as
 * `unknown` would put a US-only role back into a queue it was correctly
 * excluded from.
 */
const NON_PLACE_WORDS = new Set([
  "remote", "remotely", "hybrid", "onsite", "on", "site", "office", "based",
  "anywhere", "worldwide", "world", "wide", "global", "globally",
  "international", "distributed", "flexible", "various", "multiple",
  "location", "locations", "emea", "apac", "latam", "europe", "european",
  "eu", "any", "all", "na", "n", "a", "tbd", "tba", "unknown", "other",
  "home", "wfh", "field", "or", "and", "the", "in",
]);

/** True when every word in `lower` is a non-place word — so it names nowhere. */
function namesNoPlace(lower: string): boolean {
  const tokens = lower.split(/[^a-z0-9]+/).filter((t) => t.length > 0);
  return tokens.length > 0 && tokens.every((t) => NON_PLACE_WORDS.has(t));
}

/**
 * Country codes Indeed puts in its own hostname: `in.indeed.com`, `nl.indeed.com`.
 *
 * The leading label is which country Indeed SERVED the posting for — a fact
 * about the row, not a reading of its text. That makes this a legitimate second
 * source for the country, and the only one available for rows screened before
 * the column existed: twelve production rows carry an Indeed URL and no country,
 * and eight of them are on `in.indeed.com` while still recording a Dutch
 * partner permit as what makes them lawful.
 *
 * Deliberately narrow. Only the two markets are recognised, and only as the
 * FIRST label of the host — `www.indeed.com` and `boards.greenhouse.io` say
 * nothing about geography and must come back `unknown`, not `other`.
 */
const HOST_COUNTRY: Record<string, PostingCountry> = { in: "IN", nl: "NL" };

/**
 * Read a country out of a posting URL, or `unknown`.
 *
 * Never returns `other`: a hostname that is not one of the two country domains
 * has told us nothing, which is different from telling us the job is elsewhere.
 */
export function countryFromUrl(url: string | null | undefined): PostingCountry {
  if (!url) return "unknown";
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return "unknown";
  }
  const [label, ...rest] = host.split(".");
  // Only on a country-subdomain of a job board — `nl.example.com` is somebody's
  // Dutch marketing site, not evidence about where a role sits.
  if (!label || rest.length < 2) return "unknown";
  if (!host.endsWith("indeed.com")) return "unknown";
  return HOST_COUNTRY[label] ?? "unknown";
}

/** The country in the words the founder reads, for a gate's evidence line. */
export function countryName(country: PostingCountry): string {
  if (country === "NL") return "the Netherlands";
  if (country === "IN") return "India";
  if (country === "other") return "a country outside both your markets";
  return "an unstated location";
}

/**
 * Narrow an arbitrary stored string to the union.
 *
 * Rows written before the column existed carry NULL, and a cast would let that
 * reach the renderer as a country. Anything not positively one of the four is
 * `unknown`, which is what "nobody recorded this" is called here.
 */
export function toPostingCountry(value: unknown): PostingCountry {
  return value === "NL" || value === "IN" || value === "other" ? value : "unknown";
}
