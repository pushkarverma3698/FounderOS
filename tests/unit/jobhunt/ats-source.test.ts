/**
 * Unit tests — ATS job source (pure parts; no network).
 *
 * Fixtures are the REAL shape returned by
 * fantastic-jobs/career-site-job-listing-api on 2026-07-29, including the two
 * things the live run actually taught us: the feed writes an in-band `error`
 * item on a successful run when its upstream is down, and it posts one role
 * once per city with the city baked into the title.
 */

import { describe, it, expect } from "vitest";
import {
  buildAtsInput,
  detectFeedError,
  mapAtsItems,
  stripLocationSuffix,
  MIN_ATS_LIMIT,
  DEFAULT_TITLES,
} from "../../../src/tools/jobhunt/ats-source.js";

/** Trimmed from a real dataset item (Speechify, Greenhouse, 2026-07-29). */
const REAL_ITEM = {
  organization: "Speechify",
  title: "Software Engineer, Data Infrastructure & Acquisition - Utrecht, Netherlands",
  url: "https://job-boards.greenhouse.io/speechify/jobs/5975247004",
  description_text:
    "Operate and extend the cloud infrastructure for our ingestion pipeline, " +
    "currently running on GCP and managed with Terraform. Proficiency in Docker.",
  locations_derived: ["Utrecht, Utrecht, Netherlands"],
  date_posted: "2026-07-29T05:08:47",
};

describe("buildAtsInput", () => {
  it("always asks for full text, never a summary", () => {
    // The salary and language gates parse the body. A truncated description
    // doesn't weaken them, it makes them confidently wrong.
    expect(buildAtsInput()["descriptionType"]).toBe("text");
  });

  it("enforces the actor's minimum limit", () => {
    expect(buildAtsInput({ limit: 3 })["limit"]).toBe(MIN_ATS_LIMIT);
    expect(buildAtsInput({ limit: 50 })["limit"]).toBe(50);
  });

  it("defaults to the last 24h so daily runs do not re-screen yesterday", () => {
    expect(buildAtsInput()["timeRange"]).toBe("24h");
    expect(buildAtsInput({ timeRange: "7d" })["timeRange"]).toBe("7d");
  });

  it("does not filter on visa sponsorship at source", () => {
    // The IND register is authoritative; the feed's AI flag is a text heuristic.
    // Running the weaker filter first would silently drop real sponsors.
    expect(buildAtsInput()).not.toHaveProperty("aiVisaSponsorshipFilter");
    expect(buildAtsInput()).not.toHaveProperty("hasSalary");
  });

  it("omits organizationSearch unless targets are given", () => {
    expect(buildAtsInput()).not.toHaveProperty("organizationSearch");
    expect(buildAtsInput({ organizations: ["Booking.com"] })["organizationSearch"]).toEqual([
      "Booking.com",
    ]);
  });

  it("is deterministic for the same query", () => {
    expect(buildAtsInput({ limit: 10 })).toEqual(buildAtsInput({ limit: 10 }));
    expect(buildAtsInput()["titleSearch"]).toEqual([...DEFAULT_TITLES]);
  });

  it("excludes agencies, which re-post other companies' roles under their own name", () => {
    expect(buildAtsInput()["removeAgency"]).toBe(true);
  });
});

describe("stripLocationSuffix", () => {
  it("removes a city suffix that matches the posting's own location", () => {
    expect(
      stripLocationSuffix(
        "Software Engineer, Data Infrastructure & Acquisition - Utrecht, Netherlands",
        "Utrecht, Utrecht, Netherlands",
      ),
    ).toBe("Software Engineer, Data Infrastructure & Acquisition");
  });

  it("collapses the same role posted across four cities to one title", () => {
    const titles = [
      ["Backend Engineer - Utrecht, Netherlands", "Utrecht, Utrecht, Netherlands"],
      ["Backend Engineer - Rotterdam, Netherlands", "Rotterdam, South Holland, Netherlands"],
      ["Backend Engineer - The Hague, Netherlands", "The Hague, South Holland, Netherlands"],
    ] as const;
    const stripped = new Set(titles.map(([t, l]) => stripLocationSuffix(t, l)));
    expect(stripped).toEqual(new Set(["Backend Engineer"]));
  });

  it("keeps a suffix that is not where the job is", () => {
    expect(stripLocationSuffix("Engineer - Payments", "Amsterdam, North Holland, Netherlands")).toBe(
      "Engineer - Payments",
    );
  });

  it("leaves a title with no suffix untouched", () => {
    expect(stripLocationSuffix("Senior AI Engineer", "Amsterdam, North Holland, Netherlands")).toBe(
      "Senior AI Engineer",
    );
  });

  it("never returns an empty title", () => {
    expect(stripLocationSuffix("- Utrecht, Netherlands", "Utrecht, Utrecht, Netherlands")).toBe(
      "- Utrecht, Netherlands",
    );
  });
});

describe("detectFeedError", () => {
  it("finds the in-band error the feed writes on a SUCCESSFUL run", () => {
    // Observed live: exit code 0, 216s runtime, one item, upstream 521.
    expect(
      detectFeedError([{ error: "Failed to fetch data after 5 attempts: API request failed with status 521" }]),
    ).toContain("521");
  });

  it("returns null for a healthy dataset", () => {
    expect(detectFeedError([REAL_ITEM])).toBeNull();
    expect(detectFeedError([])).toBeNull();
  });
});

describe("mapAtsItems", () => {
  it("maps a real dataset item", () => {
    const [posting] = mapAtsItems([REAL_ITEM]);
    expect(posting).toBeDefined();
    expect(posting!.company).toBe("Speechify");
    expect(posting!.title).toBe("Software Engineer, Data Infrastructure & Acquisition");
    expect(posting!.location).toBe("Utrecht, Utrecht, Netherlands");
    expect(posting!.description).toContain("Terraform");
    expect(posting!.postedAt?.toISOString().slice(0, 10)).toBe("2026-07-29");
  });

  it("drops postings with no description rather than screening an empty body", () => {
    // A verdict from no evidence is the one outcome this pipeline exists to stop.
    expect(mapAtsItems([{ ...REAL_ITEM, description_text: "" }])).toEqual([]);
    expect(mapAtsItems([{ ...REAL_ITEM, title: "" }])).toEqual([]);
    expect(mapAtsItems([{ ...REAL_ITEM, organization: "" }])).toEqual([]);
  });

  it("survives an error item mixed into the dataset", () => {
    expect(mapAtsItems([{ error: "upstream 503" }, REAL_ITEM])).toHaveLength(1);
  });

  it("returns an empty list for junk input", () => {
    expect(mapAtsItems([])).toEqual([]);
    expect(mapAtsItems([null, undefined, 42, "nope"])).toEqual([]);
  });

  it("tolerates a missing date rather than inventing one", () => {
    const [posting] = mapAtsItems([{ ...REAL_ITEM, date_posted: "not-a-date" }]);
    expect(posting!.postedAt).toBeNull();
  });

  it("reads a zoneless feed timestamp as UTC, not as host-local time", () => {
    // The feed sends "2026-07-29T05:08:47". Parsed as local time on a UTC+5:30
    // machine that becomes 2026-07-28 UTC, so dev and the UTC production box
    // would disagree about the same posting's date.
    const [posting] = mapAtsItems([REAL_ITEM]);
    expect(posting!.postedAt?.toISOString()).toBe("2026-07-29T05:08:47.000Z");
  });

  it("respects an explicit zone when the feed supplies one", () => {
    const [posting] = mapAtsItems([{ ...REAL_ITEM, date_posted: "2026-07-29T05:08:47+02:00" }]);
    expect(posting!.postedAt?.toISOString()).toBe("2026-07-29T03:08:47.000Z");
  });
});
