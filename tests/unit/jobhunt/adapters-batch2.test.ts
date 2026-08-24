/**
 * Unit tests — the three adapters added 2026-08-24 (Workday, Teamtailor,
 * BambooHR), pure and no network.
 *
 * Every fixture here is trimmed from a REAL response captured live against
 * public boards that day (23andme/Workday, 123pousse/Teamtailor,
 * 321theagency/BambooHR) — not hand-written shapes. See the plan at
 * docs/plans (job-pipeline-expansion) for the full capture.
 */

import { describe, it, expect } from "vitest";
import { workdayAdapter, parseWorkdayPostedOn, parseWorkdayToken, workdayTokenFromUrl } from "../../../src/tools/jobhunt/adapters/workday.js";
import { teamtailorAdapter, teamtailorLocation } from "../../../src/tools/jobhunt/adapters/teamtailor.js";
import { bamboohrAdapter, bamboohrLocation } from "../../../src/tools/jobhunt/adapters/bamboohr.js";
import type { FreeBoard } from "../../../src/tools/jobhunt/free-boards.js";

function board(ats: FreeBoard["ats"], token: string, overrides: Partial<FreeBoard> = {}): FreeBoard {
  return { name: "Acme B.V.", ats, token, markets: ["NL"], ...overrides };
}

describe("workdayAdapter", () => {
  const wdBoard = board("workday", "23andme/wd5/23");

  // Trimmed from a live POST to
  // https://23andme.wd5.myworkdayjobs.com/wday/cxs/23andme/23/jobs, 2026-08-24.
  const wellFormed = {
    total: 17,
    jobPostings: [
      {
        title: "Senior Accountant",
        externalPath: "/job/Palo-Alto-HQ/Senior-Accountant_2026049",
        locationsText: "Palo Alto (HQ)",
        postedOn: "Posted 21 Days Ago",
        bulletFields: ["2026049"],
      },
    ],
  };

  it("maps a well-formed page to the right fields", () => {
    const [candidate] = workdayAdapter.listJobs(wellFormed, wdBoard);
    expect(candidate).toBeDefined();
    expect(candidate!.title).toBe("Senior Accountant");
    expect(candidate!.externalId).toBe("/job/Palo-Alto-HQ/Senior-Accountant_2026049");
    expect(candidate!.location).toBe("Palo Alto (HQ)");
    expect(candidate!.url).toBe(
      "https://23andme.wd5.myworkdayjobs.com/23/job/Palo-Alto-HQ/Senior-Accountant_2026049",
    );
  });

  it("returns description: null — Workday withholds bodies from the list payload", () => {
    const [candidate] = workdayAdapter.listJobs(wellFormed, wdBoard);
    expect(candidate!.description).toBeNull();
  });

  it("skips a posting missing a title or an externalPath", () => {
    const base = wellFormed.jobPostings[0]!;
    const noTitle = { jobPostings: [{ ...base, title: "" }] };
    const noPath = { jobPostings: [{ ...base, externalPath: "" }] };
    expect(workdayAdapter.listJobs(noTitle, wdBoard)).toEqual([]);
    expect(workdayAdapter.listJobs(noPath, wdBoard)).toEqual([]);
  });

  it("returns [] for a board whose token will not parse, rather than throwing", () => {
    expect(workdayAdapter.listJobs(wellFormed, board("workday", "not-three-parts"))).toEqual([]);
  });

  describe("extractBody", () => {
    // Trimmed from a live GET of the same posting's detail endpoint.
    it("reads jobPostingInfo.jobDescription", () => {
      const detail = {
        jobPostingInfo: { id: "8d73b44f", title: "Senior Accountant", jobDescription: "<p>Owns GL accounting…</p>" },
      };
      expect(workdayAdapter.extractBody(detail)).toBe("<p>Owns GL accounting…</p>");
    });
  });

  describe("parseWorkdayToken / workdayTokenFromUrl", () => {
    it("round-trips a corpus URL into tenant/datacenter/site", () => {
      expect(workdayTokenFromUrl("https://23andme.wd5.myworkdayjobs.com/23")).toBe("23andme/wd5/23");
    });

    it("rejects a URL on a different host", () => {
      expect(workdayTokenFromUrl("https://evil.example.com/wd5/23")).toBeNull();
    });

    it("parses a well-formed token", () => {
      expect(parseWorkdayToken("23andme/wd5/23")).toEqual({
        tenant: "23andme",
        datacenter: "wd5",
        site: "23",
      });
    });

    it("rejects a token whose middle segment is not wdN", () => {
      expect(parseWorkdayToken("23andme/notadatacenter/23")).toBeNull();
    });
  });

  describe("parseWorkdayPostedOn — must never fabricate a date", () => {
    const now = new Date("2026-08-24T12:00:00Z");

    it.each([
      ["Posted Today", now],
      ["Posted today", now],
      ["Posted Yesterday", new Date("2026-08-23T12:00:00Z")],
      ["Posted 21 Days Ago", new Date("2026-08-03T12:00:00Z")],
      ["Posted 0 Days Ago", now],
    ])("parses %s", (text, expected) => {
      expect(parseWorkdayPostedOn(text, now)?.toISOString()).toBe(expected.toISOString());
    });

    // The case this whole parser exists for: "30+ Days Ago" is an OPEN range, not
    // a measurement. Returning now-30d would place a 500-day-old role at the top
    // of a queue whose entire promise is freshness (jobindex-source.ts already
    // shipped this exact defect with `new Date()`; this is its mirror image).
    it.each([["Posted 30+ Days Ago"], [""], ["Recently"], [undefined], [null], [12345]])(
      "does NOT fabricate a date for %s — returns null",
      (input) => {
        expect(parseWorkdayPostedOn(input as unknown, now)).toBeNull();
      },
    );
  });
});

describe("teamtailorAdapter", () => {
  const ttBoard = board("teamtailor", "123pousse");

  // Trimmed from a live GET of https://123pousse.teamtailor.com/jobs.json,
  // 2026-08-24.
  const wellFormed = {
    version: "https://jsonfeed.org/version/1.1",
    items: [
      {
        id: "cc43377b-7b90-4312-bb82-b8e5a661e36d",
        title: "Auxiliaire de puériculture H/F",
        url: "https://123pousse.teamtailor.com/jobs/8157585-auxiliaire-de-puericulture-h-f",
        date_published: "2026-07-31T18:49:21+02:00",
        content_html: "<p>Notre ambition : rejoindre l'équipe.</p>",
        _jobposting: {
          "@type": "JobPosting",
          datePosted: "2026-07-31T18:49:21+02:00",
          jobLocation: [
            {
              "@type": "Place",
              address: {
                "@type": "PostalAddress",
                addressLocality: "Lormont",
                addressRegion: "Gironde",
                addressCountry: "FR",
              },
            },
          ],
        },
      },
    ],
  };

  it("maps a well-formed feed item, including an inline body and a real date", () => {
    const [candidate] = teamtailorAdapter.listJobs(wellFormed, ttBoard);
    expect(candidate).toBeDefined();
    expect(candidate!.externalId).toBe("cc43377b-7b90-4312-bb82-b8e5a661e36d");
    expect(candidate!.title).toBe("Auxiliaire de puériculture H/F");
    expect(candidate!.postedAt?.toISOString()).toBe("2026-07-31T16:49:21.000Z");
    expect(candidate!.description).toContain("rejoindre");
    expect(candidate!.location).toBe("Lormont, Gironde, FR");
  });

  it("getJobUrl returns null — the feed already inlines every body", () => {
    expect(teamtailorAdapter.getJobUrl(ttBoard, "any-id")).toBeNull();
  });

  it("skips an item missing an id, a title, or a URL", () => {
    const base = wellFormed.items[0]!;
    expect(teamtailorAdapter.listJobs({ items: [{ ...base, id: "" }] }, ttBoard)).toEqual([]);
    expect(teamtailorAdapter.listJobs({ items: [{ ...base, title: "" }] }, ttBoard)).toEqual([]);
    expect(teamtailorAdapter.listJobs({ items: [{ ...base, url: "" }] }, ttBoard)).toEqual([]);
  });

  describe("teamtailorLocation", () => {
    it("joins locality, region and country", () => {
      expect(teamtailorLocation(wellFormed.items[0]!._jobposting)).toBe("Lormont, Gironde, FR");
    });

    it("returns '' when jobLocation is absent, rather than throwing", () => {
      expect(teamtailorLocation({ "@type": "JobPosting" })).toBe("");
      expect(teamtailorLocation(null)).toBe("");
    });
  });
});

describe("bamboohrAdapter", () => {
  const bhrBoard = board("bamboohr", "321theagency");

  // Trimmed from a live GET of https://321theagency.bamboohr.com/careers/list,
  // 2026-08-24 — note the total ABSENCE of any date field, which is the whole
  // reason dateOnlyInDetail exists.
  const listPayload = {
    meta: { totalCount: 18 },
    result: [
      {
        id: "146",
        jobOpeningName: "Project Manager (Creative & Digital)",
        departmentLabel: "Project Management",
        employmentStatusLabel: "Full-Time",
        location: { city: null, state: null },
        atsLocation: { country: "United States", state: "Florida", city: "Orlando" },
        isRemote: null,
      },
    ],
  };

  it("flags dateOnlyInDetail — the funnel must defer freshness for this platform", () => {
    expect(bamboohrAdapter.dateOnlyInDetail).toBe(true);
  });

  it("maps the list payload with postedAt: null — never guessed", () => {
    const [candidate] = bamboohrAdapter.listJobs(listPayload, bhrBoard);
    expect(candidate).toBeDefined();
    expect(candidate!.externalId).toBe("146");
    expect(candidate!.title).toBe("Project Manager (Creative & Digital)");
    expect(candidate!.postedAt).toBeNull();
    expect(candidate!.description).toBeNull();
  });

  it("prefers atsLocation over an all-null location", () => {
    expect(bamboohrLocation(listPayload.result[0]!)).toBe("Orlando, Florida, United States");
  });

  it("falls back to 'Remote' only when isRemote is true and both locations are empty", () => {
    expect(bamboohrLocation({ location: {}, atsLocation: {}, isRemote: true })).toBe("Remote");
    expect(bamboohrLocation({ location: {}, atsLocation: {}, isRemote: null })).toBe("");
  });

  // Trimmed from a live GET of
  // https://321theagency.bamboohr.com/careers/146/detail, 2026-08-24 — the ONLY
  // place BambooHR states a publication date.
  const detailPayload = {
    result: {
      jobOpening: {
        jobOpeningShareUrl: "https://321theagency.bamboohr.com/careers/146",
        datePosted: "2025-07-15",
        description: "<p>The <b>JD TL;DR</b></p>",
      },
    },
  };

  it("extractBody reads result.jobOpening.description", () => {
    expect(bamboohrAdapter.extractBody(detailPayload)).toContain("JD TL;DR");
  });

  it("postedAtFromDetail reads result.jobOpening.datePosted", () => {
    expect(bamboohrAdapter.postedAtFromDetail!(detailPayload)?.toISOString()).toBe(
      "2025-07-15T00:00:00.000Z",
    );
  });

  it("postedAtFromDetail returns null rather than a fabricated date when absent", () => {
    expect(bamboohrAdapter.postedAtFromDetail!({ result: { jobOpening: {} } })).toBeNull();
  });
});
