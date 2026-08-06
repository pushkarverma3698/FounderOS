/**
 * Unit tests — normalising the three free board feeds (pure, no network).
 *
 * Fixtures follow the shapes documented in free-ats-mappers.ts's own comments:
 * Greenhouse's list endpoint carries no body and dates a posting by
 * `first_published`; Lever and Ashby return the full body inline and title the
 * job differently (`text` vs `title`). These feeds are untrusted third-party
 * JSON, so every mapper must degrade to `[]` on garbage rather than throw.
 */

import { describe, it, expect } from "vitest";
import {
  mapGreenhouseJobs,
  mapLeverPostings,
  mapAshbyJobs,
  parsePostedAt,
  toRawPosting,
  type FreeCandidate,
} from "../../../src/tools/jobhunt/free-ats-mappers.js";
import type { FreeBoard } from "../../../src/tools/jobhunt/free-boards.js";

function board(overrides: Partial<FreeBoard> = {}): FreeBoard {
  return {
    name: "Acme B.V.",
    ats: "greenhouse",
    token: "acme",
    markets: ["NL"],
    ...overrides,
  };
}

const GARBAGE: readonly unknown[] = [null, undefined, "a bare string", [1, 2, 3], { foo: "bar" }];

describe("mapGreenhouseJobs", () => {
  const wellFormed = {
    jobs: [
      {
        id: 12345,
        title: "Backend Engineer",
        absolute_url: "https://boards.greenhouse.io/acme/jobs/12345",
        location: { name: "Amsterdam, Netherlands" },
        first_published: "2026-06-01T10:00:00-04:00",
        updated_at: "2026-08-05T10:00:00-04:00",
      },
    ],
  };

  it("maps a well-formed payload to the right fields", () => {
    const [candidate] = mapGreenhouseJobs(wellFormed, board());

    expect(candidate).toBeDefined();
    expect(candidate!.externalId).toBe("12345");
    expect(candidate!.title).toBe("Backend Engineer");
    expect(candidate!.url).toBe("https://boards.greenhouse.io/acme/jobs/12345");
    expect(candidate!.location).toBe("Amsterdam, Netherlands");
  });

  it("returns description: null — the list endpoint carries no body", () => {
    const [candidate] = mapGreenhouseJobs(wellFormed, board());
    expect(candidate!.description).toBeNull();
  });

  it("uses first_published, NOT updated_at, for postedAt", () => {
    // A deliberate decision: updated_at moves on every edit, so using it would
    // re-date an old posting as new whenever anyone fixes a typo.
    const payload = {
      jobs: [
        {
          id: 1,
          title: "Old Posting, Recently Edited",
          absolute_url: "https://boards.greenhouse.io/acme/jobs/1",
          location: { name: "Amsterdam" },
          first_published: "2020-01-01T00:00:00Z",
          updated_at: "2026-08-06T00:00:00Z",
        },
      ],
    };

    const [candidate] = mapGreenhouseJobs(payload, board());

    expect(candidate!.postedAt?.toISOString()).toBe("2020-01-01T00:00:00.000Z");
  });

  it("skips a row missing an id, a title, or a URL", () => {
    const base = wellFormed.jobs[0]!;
    const noId = { jobs: [{ ...base, id: undefined }] };
    const noTitle = { jobs: [{ ...base, title: "" }] };
    const noUrl = { jobs: [{ ...base, absolute_url: "" }] };

    expect(mapGreenhouseJobs(noId, board())).toEqual([]);
    expect(mapGreenhouseJobs(noTitle, board())).toEqual([]);
    expect(mapGreenhouseJobs(noUrl, board())).toEqual([]);
  });

  it.each(GARBAGE)("returns [] rather than throwing on garbage input: %p", (garbage) => {
    expect(() => mapGreenhouseJobs(garbage, board())).not.toThrow();
    expect(mapGreenhouseJobs(garbage, board())).toEqual([]);
  });
});

describe("mapLeverPostings", () => {
  const wellFormed = [
    {
      id: "abc-123",
      text: "Backend Engineer",
      hostedUrl: "https://jobs.lever.co/acme/abc-123",
      applyUrl: "https://jobs.lever.co/acme/abc-123/apply",
      categories: { location: "Amsterdam, Netherlands", team: "Engineering" },
      createdAt: 1_735_689_600_000, // 2025-01-01T00:00:00.000Z
      descriptionPlain: "Full plain-text description.",
    },
  ];

  it("maps a well-formed payload to the right fields — title lives at `text`", () => {
    const [candidate] = mapLeverPostings(wellFormed, board({ ats: "lever" }));

    expect(candidate).toBeDefined();
    expect(candidate!.externalId).toBe("abc-123");
    expect(candidate!.title).toBe("Backend Engineer");
    expect(candidate!.url).toBe("https://jobs.lever.co/acme/abc-123");
    expect(candidate!.location).toBe("Amsterdam, Netherlands");
  });

  it("carries a real description, unlike Greenhouse", () => {
    const [candidate] = mapLeverPostings(wellFormed, board({ ats: "lever" }));
    expect(candidate!.description).toBe("Full plain-text description.");
  });

  it("reads postedAt from createdAt (epoch milliseconds)", () => {
    const [candidate] = mapLeverPostings(wellFormed, board({ ats: "lever" }));
    expect(candidate!.postedAt?.getTime()).toBe(1_735_689_600_000);
  });

  it("falls back to applyUrl when hostedUrl is absent", () => {
    const [candidate] = mapLeverPostings(
      [{ ...wellFormed[0]!, hostedUrl: "" }],
      board({ ats: "lever" }),
    );
    expect(candidate!.url).toBe("https://jobs.lever.co/acme/abc-123/apply");
  });

  it("skips a row missing an id, a title, or a URL", () => {
    const base = wellFormed[0]!;
    const noId = [{ ...base, id: undefined }];
    const noTitle = [{ ...base, text: "" }];
    const noUrl = [{ ...base, hostedUrl: "", applyUrl: "" }];

    expect(mapLeverPostings(noId, board({ ats: "lever" }))).toEqual([]);
    expect(mapLeverPostings(noTitle, board({ ats: "lever" }))).toEqual([]);
    expect(mapLeverPostings(noUrl, board({ ats: "lever" }))).toEqual([]);
  });

  it.each(GARBAGE)("returns [] rather than throwing on garbage input: %p", (garbage) => {
    expect(() => mapLeverPostings(garbage, board({ ats: "lever" }))).not.toThrow();
    expect(mapLeverPostings(garbage, board({ ats: "lever" }))).toEqual([]);
  });
});

describe("mapAshbyJobs", () => {
  const wellFormed = {
    jobs: [
      {
        id: "xyz-789",
        title: "Backend Engineer",
        jobUrl: "https://jobs.ashbyhq.com/acme/xyz-789",
        applyUrl: "https://jobs.ashbyhq.com/acme/xyz-789/apply",
        location: "Amsterdam, Netherlands",
        publishedAt: "2026-08-01T10:00:00Z",
        descriptionPlain: "Full plain-text description.",
        isListed: true,
      },
    ],
  };

  it("maps a well-formed payload to the right fields", () => {
    const [candidate] = mapAshbyJobs(wellFormed, board({ ats: "ashby" }));

    expect(candidate).toBeDefined();
    expect(candidate!.externalId).toBe("xyz-789");
    expect(candidate!.title).toBe("Backend Engineer");
    expect(candidate!.url).toBe("https://jobs.ashbyhq.com/acme/xyz-789");
    expect(candidate!.location).toBe("Amsterdam, Netherlands");
    expect(candidate!.postedAt?.toISOString()).toBe("2026-08-01T10:00:00.000Z");
  });

  it("carries a real description, unlike Greenhouse", () => {
    const [candidate] = mapAshbyJobs(wellFormed, board({ ats: "ashby" }));
    expect(candidate!.description).toBe("Full plain-text description.");
  });

  it("falls back to applyUrl when jobUrl is absent", () => {
    const [candidate] = mapAshbyJobs(
      { jobs: [{ ...wellFormed.jobs[0]!, jobUrl: "" }] },
      board({ ats: "ashby" }),
    );
    expect(candidate!.url).toBe("https://jobs.ashbyhq.com/acme/xyz-789/apply");
  });

  it("excludes rows with isListed: false — unlisted drafts are not applyable", () => {
    const unlisted = { jobs: [{ ...wellFormed.jobs[0]!, isListed: false }] };
    expect(mapAshbyJobs(unlisted, board({ ats: "ashby" }))).toEqual([]);
  });

  it("keeps a row with isListed: true and one with isListed absent", () => {
    const noFlag = { jobs: [{ ...wellFormed.jobs[0]!, isListed: undefined }] };
    expect(mapAshbyJobs(noFlag, board({ ats: "ashby" }))).toHaveLength(1);
    expect(mapAshbyJobs(wellFormed, board({ ats: "ashby" }))).toHaveLength(1);
  });

  it("skips a row missing an id, a title, or a URL", () => {
    const base = wellFormed.jobs[0]!;
    const noId = { jobs: [{ ...base, id: undefined }] };
    const noTitle = { jobs: [{ ...base, title: "" }] };
    const noUrl = { jobs: [{ ...base, jobUrl: "", applyUrl: "" }] };

    expect(mapAshbyJobs(noId, board({ ats: "ashby" }))).toEqual([]);
    expect(mapAshbyJobs(noTitle, board({ ats: "ashby" }))).toEqual([]);
    expect(mapAshbyJobs(noUrl, board({ ats: "ashby" }))).toEqual([]);
  });

  it.each(GARBAGE)("returns [] rather than throwing on garbage input: %p", (garbage) => {
    expect(() => mapAshbyJobs(garbage, board({ ats: "ashby" }))).not.toThrow();
    expect(mapAshbyJobs(garbage, board({ ats: "ashby" }))).toEqual([]);
  });
});

describe("parsePostedAt", () => {
  it("parses an ISO string with an offset", () => {
    const parsed = parsePostedAt("2025-04-23T04:30:41-04:00");
    expect(parsed?.toISOString()).toBe("2025-04-23T08:30:41.000Z");
  });

  it("parses epoch milliseconds as a number", () => {
    const parsed = parsePostedAt(1_779_392_148_604);
    expect(parsed?.getTime()).toBe(1_779_392_148_604);
  });

  it.each([
    ["an empty string", ""],
    ["a non-date string", "not-a-date"],
    ["zero", 0],
    ["a negative number", -100],
    ["null", null],
    ["undefined", undefined],
  ])("returns null, never Invalid Date or Date.now(), for %s", (_label, value) => {
    const parsed = parsePostedAt(value);
    expect(parsed).toBeNull();
  });

  it("reads a plausible epoch in SECONDS as seconds, not as 1970 milliseconds", () => {
    // 1754400000 is 2025-08-05 in seconds — and 1970-01-21 if read as ms. The
    // 1970 reading is worse than null: the freshness window then drops the row
    // as "stale", which mislabels a fresh posting as an old one.
    const parsed = parsePostedAt(1_754_400_000);
    expect(parsed?.toISOString()).toBe("2025-08-05T13:20:00.000Z");
  });

  it("returns null for a numeric timestamp too small to be a real posting date", () => {
    // A tiny number is neither a credible seconds nor ms timestamp. Undated is
    // the honest answer — the filter counts "undated" as its own bucket.
    expect(parsePostedAt(5)).toBeNull();
    expect(parsePostedAt(999)).toBeNull();
  });
});

describe("toRawPosting", () => {
  it("derives country from the posting's OWN location, not the board's markets column", () => {
    // The board was sourced for the Dutch list, but this particular posting is
    // in India. Trusting `markets` here would silently mislabel the row.
    const dutchSourcedBoard = board({ markets: ["NL"] });
    const candidate: FreeCandidate = {
      board: dutchSourcedBoard,
      externalId: "1",
      title: "Backend Engineer",
      url: "https://example.com/job/1",
      location: "Bangalore, India",
      postedAt: new Date("2026-08-01T00:00:00Z"),
      description: null,
    };

    const raw = toRawPosting(candidate, "Full description.");

    expect(raw.country).toBe("IN");
  });

  it("carries the board name, description, provenance and ids through", () => {
    const candidate: FreeCandidate = {
      board: board({ name: "Acme B.V." }),
      externalId: "42",
      title: "Backend Engineer",
      url: "https://example.com/job/42",
      location: "Amsterdam, Netherlands",
      postedAt: new Date("2026-08-01T00:00:00Z"),
      description: null,
    };

    const raw = toRawPosting(candidate, "Hydrated body text.");

    expect(raw.company).toBe("Acme B.V.");
    expect(raw.title).toBe("Backend Engineer");
    expect(raw.url).toBe("https://example.com/job/42");
    expect(raw.description).toBe("Hydrated body text.");
    expect(raw.externalId).toBe("42");
    expect(raw.source).toBe("free-ats-ingest");
    expect(raw.country).toBe("NL");
  });
});
