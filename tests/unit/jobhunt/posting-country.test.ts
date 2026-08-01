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
import { countryFromLocation, countryName } from "../../../src/tools/jobhunt/country.js";
import { extractRoute } from "../../../src/tools/jobhunt/extract.js";

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
