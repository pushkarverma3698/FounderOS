/**
 * Unit tests — the SmartRecruiters and Workable adapters.
 *
 * WHY THESE TWO, AND NOT PERSONIO. Joining the 12,883-row IND register against
 * the published ATS corpora on 2026-08-21 measured:
 *
 *   smartrecruiters   2,747 companies → 145 IND-sponsor boards
 *   workable          4,268 companies →  86 IND-sponsor boards
 *   personio          2,463 companies →  78 IND-sponsor boards
 *
 * The first two are public JSON APIs and need a mapper each. Personio is not:
 * its `search.json` returns no description (verified empty on every job of two
 * boards, 319 and 2), no posting URL and no date, so the only usable feed is
 * `/xml` — a different fetch path, an XML parser, and about 2 MB per company
 * because descriptions are inlined. At 78 boards that is ~156 MB every thirty
 * minutes. It is deferred deliberately, with the numbers, rather than dropped.
 *
 * WHAT THE FIXTURES ARE. Trimmed captures of real responses taken live on
 * 2026-08-21, not invented shapes. A mapper tested against a guess passes in CI
 * and returns nothing in production, which is the failure mode this whole lane
 * is built to make impossible.
 */

import { describe, it, expect } from "vitest";
import {
  mapSmartRecruitersPostings,
  mapWorkableJobs,
  FREE_MAPPERS,
} from "../../../src/tools/jobhunt/free-ats-mappers.js";
import { boardUrl, jobBodyUrl, PLATFORM_CONCURRENCY } from "../../../src/tools/jobhunt/free-ats-source.js";
import type { FreeBoard } from "../../../src/tools/jobhunt/free-boards.js";

const SR_BOARD: FreeBoard = {
  name: "1Huddle",
  ats: "smartrecruiters",
  token: "1huddle",
  markets: ["NL"],
};

const WK_BOARD: FreeBoard = {
  name: "1000heads",
  ats: "workable",
  token: "1000heads",
  markets: ["NL"],
};

/** Trimmed from the live `/v1/companies/1huddle/postings` response. */
const SR_PAYLOAD = {
  offset: 0,
  limit: 100,
  totalFound: 2,
  content: [
    {
      id: "744000056465632",
      name: "Associate, Internship Team",
      releasedDate: "2025-04-29T17:58:57.823Z",
      location: { city: "Newark", region: "NJ", country: "us", fullLocation: "Newark, NJ, United States" },
    },
    {
      id: "744000099999999",
      name: "Senior Backend Engineer",
      releasedDate: "2026-08-20T09:00:00.000Z",
      location: { city: "Amsterdam", country: "nl", fullLocation: "Amsterdam, Netherlands" },
    },
  ],
};

/** Trimmed from the live `/api/v1/widget/accounts/1000heads?details=true` response. */
const WK_PAYLOAD = {
  name: "1000heads",
  description: "<p>We are a social transformation company.</p>",
  jobs: [
    {
      title: "Account Director",
      shortcode: "E4335D00D8",
      url: "https://apply.workable.com/j/E4335D00D8",
      application_url: "https://apply.workable.com/j/E4335D00D8/apply",
      published_on: "2026-07-28",
      country: "United States",
      city: "New York",
      state: "New York",
      description: "<p>The Account Director will lead retainer clients.</p>",
    },
  ],
};

describe("mapSmartRecruitersPostings", () => {
  it("maps every posting in the payload", () => {
    expect(mapSmartRecruitersPostings(SR_PAYLOAD, SR_BOARD)).toHaveLength(2);
  });

  it("reads the id, the title and the date the posting was released", () => {
    const [first] = mapSmartRecruitersPostings(SR_PAYLOAD, SR_BOARD);
    expect(first?.externalId).toBe("744000056465632");
    expect(first?.title).toBe("Associate, Internship Team");
    expect(first?.postedAt?.toISOString()).toBe("2025-04-29T17:58:57.823Z");
  });

  it("builds the public posting URL, since the list endpoint does not carry one", () => {
    // Verified live 2026-08-21: /{company}/{id} resolves 200 without the slug.
    const [first] = mapSmartRecruitersPostings(SR_PAYLOAD, SR_BOARD);
    expect(first?.url).toBe("https://jobs.smartrecruiters.com/1huddle/744000056465632");
  });

  it("uses the full location string, which is what the country gate reads", () => {
    const [, second] = mapSmartRecruitersPostings(SR_PAYLOAD, SR_BOARD);
    expect(second?.location).toBe("Amsterdam, Netherlands");
  });

  it("leaves the description null so hydration fetches the real body", () => {
    // The list endpoint carries no body at all — same as Greenhouse.
    const [first] = mapSmartRecruitersPostings(SR_PAYLOAD, SR_BOARD);
    expect(first?.description).toBeNull();
  });

  it("skips a row with no id or no title rather than emitting a broken one", () => {
    const broken = { content: [{ id: "", name: "Ghost" }, { id: "1", name: "" }] };
    expect(mapSmartRecruitersPostings(broken, SR_BOARD)).toEqual([]);
  });

  it("returns nothing for a payload that is not a posting list", () => {
    expect(mapSmartRecruitersPostings({ error: "not found" }, SR_BOARD)).toEqual([]);
    expect(mapSmartRecruitersPostings(null, SR_BOARD)).toEqual([]);
  });
});

describe("mapWorkableJobs", () => {
  it("maps the jobs array", () => {
    expect(mapWorkableJobs(WK_PAYLOAD, WK_BOARD)).toHaveLength(1);
  });

  it("reads id, title, url and date from the widget payload", () => {
    const [job] = mapWorkableJobs(WK_PAYLOAD, WK_BOARD);
    expect(job?.externalId).toBe("E4335D00D8");
    expect(job?.title).toBe("Account Director");
    expect(job?.url).toBe("https://apply.workable.com/j/E4335D00D8");
    expect(job?.postedAt?.toISOString().slice(0, 10)).toBe("2026-07-28");
  });

  it("assembles a location from the parts, because there is no single field", () => {
    const [job] = mapWorkableJobs(WK_PAYLOAD, WK_BOARD);
    expect(job?.location).toBe("New York, New York, United States");
  });

  it("carries the description, so Workable needs no hydration round trip", () => {
    const [job] = mapWorkableJobs(WK_PAYLOAD, WK_BOARD);
    expect(job?.description).toContain("Account Director will lead");
    // Decoded the same way every other body is: tags become spaces, entities resolve.
    expect(job?.description).not.toContain("<p>");
  });

  it("does not mistake the account description for a job", () => {
    // The payload's top-level `description` is the company blurb. Reading it as
    // a posting would put one fake row on every Workable board in the registry.
    const jobs = mapWorkableJobs(WK_PAYLOAD, WK_BOARD);
    expect(jobs.every((j) => !j.title.includes("social transformation"))).toBe(true);
  });

  it("falls back to the apply URL when the posting URL is missing", () => {
    const payload = { jobs: [{ ...WK_PAYLOAD.jobs[0], url: "" }] };
    const [job] = mapWorkableJobs(payload, WK_BOARD);
    expect(job?.url).toBe("https://apply.workable.com/j/E4335D00D8/apply");
  });

  it("returns nothing for a payload with no jobs array", () => {
    expect(mapWorkableJobs({ name: "x" }, WK_BOARD)).toEqual([]);
    expect(mapWorkableJobs(null, WK_BOARD)).toEqual([]);
  });
});

describe("the sweep knows about both platforms", () => {
  it("registers a mapper for each", () => {
    expect(FREE_MAPPERS.smartrecruiters).toBe(mapSmartRecruitersPostings);
    expect(FREE_MAPPERS.workable).toBe(mapWorkableJobs);
  });

  it("builds the list URL for each", () => {
    expect(boardUrl(SR_BOARD)).toBe(
      "https://api.smartrecruiters.com/v1/companies/1huddle/postings?limit=100",
    );
    expect(boardUrl(WK_BOARD)).toBe(
      "https://apply.workable.com/api/v1/widget/accounts/1000heads?details=true",
    );
  });

  it("asks SmartRecruiters for a full page, not its default of ten", () => {
    // The default page size silently truncates any board with more than ten
    // openings, which is exactly the boards worth polling.
    expect(boardUrl(SR_BOARD)).toContain("limit=100");
  });

  it("gives every platform a concurrency, so a new one cannot default to unlimited", () => {
    for (const ats of Object.keys(FREE_MAPPERS)) {
      expect(PLATFORM_CONCURRENCY[ats as keyof typeof PLATFORM_CONCURRENCY]).toBeGreaterThan(0);
    }
  });
});

describe("jobBodyUrl — hydration is per platform, not per Greenhouse", () => {
  it("fetches a Greenhouse body from the Greenhouse job endpoint", () => {
    const gh: FreeBoard = { name: "Adyen", ats: "greenhouse", token: "adyen", markets: ["NL"] };
    expect(jobBodyUrl(gh, "123")).toBe(
      "https://boards-api.greenhouse.io/v1/boards/adyen/jobs/123",
    );
  });

  it("fetches a SmartRecruiters body from its own posting endpoint", () => {
    // Before this, hydration hardcoded the Greenhouse URL. A SmartRecruiters
    // posting would have been hydrated from boards-api.greenhouse.io — a 404 per
    // posting, logged as "could not fetch posting body", leaving every row
    // bodyless and therefore dropped before screening.
    expect(jobBodyUrl(SR_BOARD, "744000056465632")).toBe(
      "https://api.smartrecruiters.com/v1/companies/1huddle/postings/744000056465632",
    );
  });

  it("returns null for platforms whose list already carries the body", () => {
    // Workable, Ashby and Recruitee all include the description inline. Asking
    // again would triple our request count at a third party for nothing.
    expect(jobBodyUrl(WK_BOARD, "E4335D00D8")).toBeNull();
    const ashby: FreeBoard = { name: "x", ats: "ashby", token: "x", markets: ["NL"] };
    expect(jobBodyUrl(ashby, "1")).toBeNull();
  });
});
