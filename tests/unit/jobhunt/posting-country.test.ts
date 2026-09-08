/**
 * Unit tests — where a job is, is FETCHED, never guessed from prose.
 *
 * THE DEFECT THIS LOCKS SHUT (live prod sweep, 2026-08-01). `extractRoute` read
 * the posting text and returned `hsm` — which means "Netherlands, highly skilled
 * migrant" — whenever `ONSITE_MARKER` matched and `REMOTE_MARKER` did not. That
 * marker is `on-site|onsite|hybrid|hybride|relocation|office-based|…` and NOT ONE
 * TOKEN IN IT NAMES A COUNTRY. So an Indian ad saying "hybrid" was classified as
 * a Dutch on-site role, screened under Dutch immigration law, and stored with a
 * Dutch permit basis. Nine rows from the Indeed **IN** feed sat in production
 * that way.
 *
 * The fix is not a better regex. The FETCHER already knows the country — it
 * queried Indeed IN rather than Indeed NL, and the ATS feed returns a location on
 * every posting — and threw it away so the screener could re-guess it from the
 * ad's wording. A fact was being replaced by an inference. These tests hold the
 * fact in place: a stated country always beats the prose, and prose is consulted
 * only where no country was fetched.
 */

import { describe, it, expect } from "vitest";
import {
  countryFromLocation,
  countryFromUrl,
  countryName,
} from "../../../src/tools/jobhunt/country.js";
import { extractRoute } from "../../../src/tools/jobhunt/extract.js";
import { getProfile } from "../../../src/tools/jobhunt/profile-config.js";

describe("countryFromLocation — reading the feed's own location string", () => {
  it("recognises the Netherlands from a city, region, country phrase", () => {
    expect(countryFromLocation("Amsterdam, North Holland, Netherlands")).toBe("NL");
    expect(countryFromLocation("Utrecht, Netherlands")).toBe("NL");
    expect(countryFromLocation("Netherlands")).toBe("NL");
  });

  it("recognises India, including the hub cities on their own", () => {
    expect(countryFromLocation("Bengaluru, Karnataka, India")).toBe("IN");
    expect(countryFromLocation("India")).toBe("IN");
    // The ATS feed sometimes returns only `cities_derived`, with no country.
    expect(countryFromLocation("Bangalore")).toBe("IN");
    expect(countryFromLocation("Hyderabad")).toBe("IN");
    expect(countryFromLocation("Gurgaon")).toBe("IN");
  });

  it("calls a third country a third country, not a missing one", () => {
    // The exact live row that started this: a Colombian company sat at rank 2 of
    // APPLY TODAY justified by a Dutch partner permit. "other" is a FINDING —
    // it means we know where this is and it is neither market.
    expect(countryFromLocation("Bogotá, Colombia")).toBe("other");
    expect(countryFromLocation("São Paulo, Brazil")).toBe("other");
    expect(countryFromLocation("Austin, Texas, United States")).toBe("other");
  });

  it("returns unknown for an empty or unreadable location, never a guess", () => {
    expect(countryFromLocation("")).toBe("unknown");
    expect(countryFromLocation("   ")).toBe("unknown");
    expect(countryFromLocation("Remote")).toBe("unknown");
    expect(countryFromLocation("Worldwide")).toBe("unknown");
  });

  it("does not match a country name embedded in an unrelated word", () => {
    // "Indiana" is not India. A substring match here would file every Indianapolis
    // role as an Indian local hire and apply an INR pay yardstick to a US salary.
    expect(countryFromLocation("Indianapolis, Indiana, United States")).toBe("other");
  });

  it("names the country in words, for the founder-facing evidence line", () => {

    expect(countryName("IN")).toBe("India");
    expect(countryName("NL")).toBe("the Netherlands");
  });
});

describe("countryFromUrl — Indeed's own hostname is a fact about the row", () => {
  it("reads the country domain", () => {
    // Live prod: 12 rows carry an Indeed URL and no country, and eight of them
    // are on in.indeed.com while recording a Dutch partner permit as what makes
    // them lawful. The hostname is which country Indeed SERVED the posting for.
    expect(countryFromUrl("https://in.indeed.com/viewjob?jk=7a18c604670561dc")).toBe("IN");
    expect(countryFromUrl("https://nl.indeed.com/viewjob?jk=bfba205e5141ae43")).toBe("NL");
  });

  it("returns unknown — never `other` — for a host that says nothing", () => {
    // `other` is a claim that the job IS somewhere else, which narrows the
    // lawful bases to one. A greenhouse URL supports no such claim.
    expect(countryFromUrl("https://boards.greenhouse.io/acme/jobs/1")).toBe("unknown");
    expect(countryFromUrl("https://www.indeed.com/viewjob?jk=1")).toBe("unknown");
    expect(countryFromUrl("https://jobs.lever.co/acme/1")).toBe("unknown");
  });

  it("does not read a country code off any old subdomain", () => {
    // `nl.example.com` is somebody's Dutch marketing site, not evidence about
    // where a role sits.
    expect(countryFromUrl("https://nl.example.com/careers/1")).toBe("unknown");
  });

  it("survives a missing or malformed URL rather than throwing", () => {
    expect(countryFromUrl(null)).toBe("unknown");
    expect(countryFromUrl(undefined)).toBe("unknown");
    expect(countryFromUrl("")).toBe("unknown");
    expect(countryFromUrl("not a url")).toBe("unknown");
  });
});

describe("extractRoute — a fetched country outranks the ad's wording", () => {
  const HYBRID_AD =
    "We are hiring a Backend Engineer. This is a hybrid role, three days in the office.";

  it("REGRESSION: an Indian hybrid ad is an Indian role, not a Dutch one", () => {
    // Before the fix this returned "hsm" — a claim that the job was in the
    // Netherlands and needed a sponsor, made purely because the ad said "hybrid".
    expect(extractRoute(HYBRID_AD, "IN")).toBe("india");
  });

  it("still reads a Dutch hybrid ad as a Netherlands role", () => {
    // Same words, opposite verdict — because the COUNTRY is what changed, which
    // is the entire argument. "Hybrid" is not evidence; "NL" is.
    expect(extractRoute(HYBRID_AD, "NL")).toBe("hsm");
  });

  it("a fully-remote Dutch posting stays reachable as a contract", () => {
    const ad = "Fully remote position, work from anywhere in Europe.";
    expect(extractRoute(ad, "NL")).toBe("remote-contract");
  });

  it("a third country is only ever reachable as a remote contract", () => {
    // Not a reject and not a silent pass: the basis is narrowed to the only one
    // that could carry it, and the Location gate then asks the question.
    expect(extractRoute(HYBRID_AD, "other")).toBe("remote-contract");
  });

  it("falls back to the prose ONLY when no country was fetched", () => {
    expect(extractRoute("Fully remote, freelance contract.", "unknown")).toBe("remote-contract");
    expect(extractRoute("We are hiring an engineer.", "unknown")).toBe("unclear");
    // Words that genuinely name an immigration context still settle it. These
    // ARE evidence about the kind of role; a desk arrangement is not.
    expect(extractRoute("Visa sponsorship available for the right candidate.", "unknown")).toBe(
      "hsm",
    );
    expect(extractRoute("We hire kennismigranten and support relocation.", "unknown")).toBe("hsm");
  });

  it("REGRESSION: a desk arrangement alone can never invent a country", () => {
    // The root of the whole defect. "Hybrid" is hybrid everywhere on earth, and
    // it used to return "hsm" — a positive claim that the job was in the
    // Netherlands and needed a sponsor. It must now leave the question open, so
    // the Location gate raises it instead of the pipeline assuming it.
    expect(extractRoute(HYBRID_AD, "unknown")).toBe("unclear");
    expect(extractRoute("On-site, five days a week in the office.", "unknown")).toBe("unclear");
    expect(extractRoute("This is an office-based position.", "unknown")).toBe("unclear");
  });

  it("defaults to unknown when no country is passed at all", () => {
    // Every existing caller that has not been taught about countries keeps its
    // old behaviour rather than silently acquiring a country it never supplied.
    expect(extractRoute("We are hiring an engineer.")).toBe("unclear");
  });
});

describe("countryFromLocation — the coverage measured as missing on 2026-08-20", () => {
  // Every case here comes from a 4,412-posting sample of the live free
  // registry. A location the pipeline reads as `other` is dropped BEFORE
  // screening, so each of these was a real posting thrown away for a spelling.

  it("recognises the Indian cities that were being filed as another country", () => {
    // 15 postings in one 90-board sample carried these and were dropped.
    expect(countryFromLocation("Lucknow")).toBe("IN");
    expect(countryFromLocation("Lucknow, Uttar Pradesh")).toBe("IN");
    expect(countryFromLocation("Varanasi")).toBe("IN");
    expect(countryFromLocation("Bareilly")).toBe("IN");
    expect(countryFromLocation("Mysore")).toBe("IN");
    expect(countryFromLocation("Nashik")).toBe("IN");
    expect(countryFromLocation("Tirupati")).toBe("IN");
    expect(countryFromLocation("Vadodara")).toBe("IN");
    expect(countryFromLocation("Surat")).toBe("IN");
  });

  it("recognises Dutch locations beyond the first nineteen cities", () => {
    // "Schiphol-Rijk" is an office park fifteen minutes from Amsterdam and was
    // being read as a country outside both markets.
    expect(countryFromLocation("Schiphol-Rijk")).toBe("NL");
    expect(countryFromLocation("Hoofddorp")).toBe("NL");
    expect(countryFromLocation("Den Bosch")).toBe("NL");
    expect(countryFromLocation("Enschede")).toBe("NL");
    expect(countryFromLocation("Zoetermeer")).toBe("NL");
  });

  it("reads a location whose every word names nowhere as unknown, not elsewhere", () => {
    // Bare "Remote" was already `unknown` (kept and screened). Decorated
    // versions of the same non-fact fell through to `other` and were dropped,
    // so identical postings got opposite treatment on punctuation alone.
    expect(countryFromLocation("Remote - Europe")).toBe("unknown");
    expect(countryFromLocation("Remote-EMEA")).toBe("unknown");
    expect(countryFromLocation("EU (Remote)")).toBe("unknown");
    expect(countryFromLocation("Remote Globally")).toBe("unknown");
    expect(countryFromLocation("Remote in Europe")).toBe("unknown");
  });

  it("reads a bare country code, which only the whole-string case makes safe", () => {
    // The two-letter codes stay out of the name lists because `\bin\b` matches
    // the preposition in "Remote in Europe". When the code IS the entire field
    // there is no preposition to confuse — and one live board emits exactly "IN".
    expect(countryFromLocation("IN")).toBe("IN");
    expect(countryFromLocation("NL")).toBe("NL");
    expect(countryFromLocation("nl")).toBe("NL");
  });

  it("REGRESSION: widening the lists did not start claiming wrong countries", () => {
    // Each of these is a place that shares a name with, or reads like, one of
    // the newly added entries. A wrong country asserts; an unknown one asks.
    expect(countryFromLocation("Hasselt, Limburg, Belgium")).toBe("other");
    expect(countryFromLocation("Bergen, Norway")).toBe("other");
    expect(countryFromLocation("Salem, Oregon")).toBe("other");
    expect(countryFromLocation("Punjab, Pakistan")).toBe("other");
    expect(countryFromLocation("Indianapolis, Indiana")).toBe("other");
    expect(countryFromLocation("Auckland, New Zealand")).toBe("other");
    // Still names a country, so it must NOT collapse into "nowhere".
    expect(countryFromLocation("Remote, United States")).toBe("other");
    expect(countryFromLocation("Remote, United Kingdom")).toBe("other");
    // And a real market survives the decoration it always did.
    expect(countryFromLocation("Remote - Netherlands")).toBe("NL");
  });
});

describe("the NL/IN fallback is scoped to the profile's own markets", () => {
  /**
   * MEASURED IN PROD, 2026-09-07. Tashi's profile targets the Netherlands and
   * nothing else — she is on a zoekjaar, and has no basis to work in India. Her
   * tracker nonetheless held 56 Indian rows against 16 Dutch ones, and `/jobs
   * tashi` rendered "Nothing actionable today" above a list of 14 roles all
   * rejected as "This role's market (India, local hire) is not one you have a
   * legal basis for".
   *
   * The route in: `countryFromLocation` walked the profile's target countries,
   * missed, and then fell through to a HARDCODED NL/IN pair that predates
   * multi-profile. "Hyderabad, India" came back as `IN` — a real market code, so
   * `filterCandidates` (which drops only `other`) kept it, the body was fetched,
   * the gates ran, and the legal gate rejected it. Every stage after the filter
   * did its job correctly on a row that should never have reached them.
   *
   * The fallback still exists — the hardcoded city lists are wider than any
   * profile's — but it may only speak for a market the profile actually targets.
   */
  /**
   * Driven by a purpose-built NL-only profile since 2026-09-08. It used to use
   * `wife-nl-finance` directly, which stopped being an NL-only profile the day
   * the founder said "Tashi will also apply in india" — and a scoping test whose
   * fixture is a declared fact about a person silently stops testing its rule
   * when that person's situation changes. The rule is about the FALLBACK, not
   * about her, so the fixture no longer names her.
   */
  const nlOnly = {
    ...getProfile("wife-nl-finance"),
    targetCountries: getProfile("wife-nl-finance").targetCountries.filter((c) => c.code === "NL"),
  };

  it("does not label a posting IN for a profile that does not target India", () => {
    expect(countryFromLocation("Hyderabad, India", nlOnly)).toBe("other");
    expect(countryFromLocation("Bengaluru, Karnataka, India", nlOnly)).toBe("other");
    expect(countryFromLocation("Gurugram", nlOnly)).toBe("other");
  });

  it("still reads the markets that profile DOES target", () => {
    expect(countryFromLocation("Amsterdam, Netherlands", nlOnly)).toBe("NL");
    // Via the hardcoded NL city list, which is wider than the profile's own.
    expect(countryFromLocation("Remote - Netherlands", nlOnly)).toBe("NL");
    expect(countryFromLocation("Berlin, Germany", nlOnly)).toBe("other");
  });

  it("reads India for the NL-finance profile now that it declares that market", () => {
    // The other half of the same rule: the fallback speaks for a market the
    // profile targets, and as of 2026-09-08 she targets this one.
    const wife = getProfile("wife-nl-finance");
    expect(countryFromLocation("Hyderabad, India", wife)).toBe("IN");
    expect(countryFromLocation("Gurugram", wife)).toBe("IN");
  });

  it("leaves the dual-market profile exactly as it was", () => {
    // Pushkar declares both NL and IN, so the fallback is unchanged for him.
    expect(countryFromLocation("Hyderabad, India")).toBe("IN");
    expect(countryFromLocation("Amsterdam, Netherlands")).toBe("NL");
    expect(countryFromLocation("Bogotá, Colombia")).toBe("other");
  });
});
