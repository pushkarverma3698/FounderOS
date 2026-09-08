/**
 * A market we already downloaded must not be thrown away
 * ======================================================
 * MEASURED ON PROD, 2026-09-08. Michael Kors' Paris shop-floor vacancy
 * ("Vendeur(se) avec expérience CDD 28h") was stored `country='unknown'`,
 * `location=''`, survived a Netherlands-only market filter — `unknown` is kept
 * on purpose, because a genuinely remote role states no country — and reached
 * `brief_section='ask'`, `brief_rank=2` of a brief with three ranked rows.
 *
 * The cause was not a missing source. Workday's LIST payload left `locationsText`
 * empty for that tenant, and the DETAIL payload — which `hydrateDescriptions`
 * already fetches for its description — carried the answer:
 *
 *   jobPostingInfo.location = "Paris"
 *   jobPostingInfo.country  = { descriptor: "France" }
 *
 * verified live against the real endpoint that day. So the market was known and
 * discarded, which is a strictly worse failure than not knowing it.
 *
 * The freshness gate had this exact shape first (`dateOnlyInDetail` +
 * `applyDeferredFreshness`, for BambooHR), and this follows it deliberately
 * rather than inventing a second mechanism.
 */

import { describe, it, expect } from "vitest";
import { workdayAdapter } from "../../../src/tools/jobhunt/adapters/workday.js";
import { applyDeferredMarket, mergeDetailLocation } from "../../../src/tools/jobhunt/free-ingest-filters.js";
import { getProfile } from "../../../src/tools/jobhunt/profile-config.js";
import type { NormalizedJob } from "../../../src/tools/jobhunt/adapters/types.js";

/** Shaped from the real response captured 2026-09-08. */
const PARIS_DETAIL = {
  jobPostingInfo: {
    title: "Vendeur(se) avec expérience CDD 28h",
    location: "Paris",
    country: { descriptor: "France", id: "54c5b6971ffb4bf0b116fe7651ec789a" },
    startDate: "2026-09-07",
    jobDescription: "<p>Vendeur en boutique.</p>",
  },
};

const AMSTERDAM_DETAIL = {
  jobPostingInfo: {
    location: "Amsterdam",
    country: { descriptor: "Netherlands" },
    jobDescription: "<p>Finance role.</p>",
  },
};

const board = { name: "Michael Kors", ats: "workday" as const, token: "capri/wd1/michael_kors", markets: [] };

function candidate(location: string): NormalizedJob {
  return {
    board,
    externalId: "/job/Paris/Sales-Associate-CDD-28h_R_785876",
    title: "Vendeur(se) avec expérience CDD 28h",
    url: "https://capri.wd1.myworkdayjobs.com/michael_kors/job/Paris/x",
    location,
    postedAt: new Date("2026-09-07T00:00:00Z"),
    description: "Vendeur en boutique.",
  };
}

describe("the Workday adapter reads the location the list payload withheld", () => {
  it("returns the city and the country name from the detail payload", () => {
    expect(workdayAdapter.locationFromDetail?.(PARIS_DETAIL)).toBe("Paris");
    expect(workdayAdapter.countryFromDetail?.(PARIS_DETAIL)).toBe("France");
  });

  it("returns null rather than a guess when the payload says nothing", () => {
    expect(workdayAdapter.locationFromDetail?.({})).toBeNull();
    expect(workdayAdapter.countryFromDetail?.({ jobPostingInfo: {} })).toBeNull();
    // An absent answer must stay unknown — never become a confident wrong one.
    expect(workdayAdapter.countryFromDetail?.({ jobPostingInfo: { country: {} } })).toBeNull();
  });
});

describe("merging the detail location into the candidate's own", () => {
  it("fills an empty location with city and country", () => {
    expect(mergeDetailLocation("", "Paris", "France")).toBe("Paris, France");
  });

  it("does not repeat a country the location already names", () => {
    expect(mergeDetailLocation("Amsterdam, Netherlands", "Amsterdam", "Netherlands")).toBe(
      "Amsterdam, Netherlands",
    );
  });

  it("keeps what the list payload already said when the detail adds nothing", () => {
    expect(mergeDetailLocation("Hengelo", null, null)).toBe("Hengelo");
    expect(mergeDetailLocation("", null, null)).toBe("");
  });

  it("adds only the country when the city is already there", () => {
    expect(mergeDetailLocation("Paris", null, "France")).toBe("Paris, France");
  });
});

describe("the deferred market gate drops what the detail fetch just placed", () => {
  const wife = getProfile("wife-nl-finance");

  it("drops a French posting from a NL/IN lane, and counts it", () => {
    const result = applyDeferredMarket([candidate("Paris, France")], wife);
    expect(result.kept).toHaveLength(0);
    expect(result.offMarket).toBe(1);
  });

  it("keeps a posting in a market the profile targets", () => {
    const result = applyDeferredMarket([candidate("Amsterdam, Netherlands")], wife);
    expect(result.kept).toHaveLength(1);
    expect(result.offMarket).toBe(0);
  });

  it("keeps an UNKNOWN location — a remote role states no country", () => {
    // This is the rule the whole defect hid behind, and it must survive the fix:
    // `unknown` is not `other`, and dropping it would lose the most reachable
    // roles on every board.
    const result = applyDeferredMarket([candidate("")], wife);
    expect(result.kept).toHaveLength(1);
    expect(result.offMarket).toBe(0);
  });

  it("is a no-op for the founder's Indian market", () => {
    const result = applyDeferredMarket([candidate("Bengaluru, India")], getProfile("pushkar-nl-tech"));
    expect(result.kept).toHaveLength(1);
  });
});

describe("hydration carries the detail location onto the candidate", () => {
  it("uses the adapter hooks when the list payload left the location empty", async () => {
    const { applyDetailLocation } = await import("../../../src/tools/jobhunt/free-ats-hydrate.js");
    expect(applyDetailLocation(candidate(""), workdayAdapter, PARIS_DETAIL)).toBe("Paris, France");
    expect(applyDetailLocation(candidate("Amsterdam"), workdayAdapter, AMSTERDAM_DETAIL)).toBe(
      "Amsterdam, Netherlands",
    );
  });
});
