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
import { greenhouseAdapter } from "../../../src/tools/jobhunt/adapters/greenhouse.js";
import { leverAdapter } from "../../../src/tools/jobhunt/adapters/lever.js";
import { ashbyAdapter } from "../../../src/tools/jobhunt/adapters/ashby.js";
import { recruiteeAdapter } from "../../../src/tools/jobhunt/adapters/recruitee.js";
import { decodeJobBody, parsePostedAt, type NormalizedJob as FreeCandidate } from "../../../src/tools/jobhunt/adapters/types.js";
import { toRawPosting } from "../../../src/tools/jobhunt/free-ingest.js";
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

describe("greenhouseAdapter", () => {
  const adapter = greenhouseAdapter;
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
    const [candidate] = adapter.listJobs(wellFormed, board());

    expect(candidate).toBeDefined();
    expect(candidate!.externalId).toBe("12345");
    expect(candidate!.title).toBe("Backend Engineer");
    expect(candidate!.url).toBe("https://boards.greenhouse.io/acme/jobs/12345");
    expect(candidate!.location).toBe("Amsterdam, Netherlands");
  });

  it("returns description: null — the list endpoint carries no body", () => {
    const [candidate] = adapter.listJobs(wellFormed, board());
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

    const [candidate] = adapter.listJobs(payload, board());

    expect(candidate!.postedAt?.toISOString()).toBe("2020-01-01T00:00:00.000Z");
  });

  it("skips a row missing an id, a title, or a URL", () => {
    const base = wellFormed.jobs[0]!;
    const noId = { jobs: [{ ...base, id: undefined }] };
    const noTitle = { jobs: [{ ...base, title: "" }] };
    const noUrl = { jobs: [{ ...base, absolute_url: "" }] };

    expect(adapter.listJobs(noId, board())).toEqual([]);
    expect(adapter.listJobs(noTitle, board())).toEqual([]);
    expect(adapter.listJobs(noUrl, board())).toEqual([]);
  });

  it.each(GARBAGE)("returns [] rather than throwing on garbage input: %p", (garbage) => {
    expect(() => adapter.listJobs(garbage, board())).not.toThrow();
    expect(adapter.listJobs(garbage, board())).toEqual([]);
  });
});

describe("leverAdapter", () => {
  const adapter = leverAdapter;
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
    const [candidate] = adapter.listJobs(wellFormed, board({ ats: "lever" }));

    expect(candidate).toBeDefined();
    expect(candidate!.externalId).toBe("abc-123");
    expect(candidate!.title).toBe("Backend Engineer");
    expect(candidate!.url).toBe("https://jobs.lever.co/acme/abc-123");
    expect(candidate!.location).toBe("Amsterdam, Netherlands");
  });

  it("carries a real description, unlike Greenhouse", () => {
    const [candidate] = adapter.listJobs(wellFormed, board({ ats: "lever" }));
    expect(candidate!.description).toBe("Full plain-text description.");
  });

  it("reads postedAt from createdAt (epoch milliseconds)", () => {
    const [candidate] = adapter.listJobs(wellFormed, board({ ats: "lever" }));
    expect(candidate!.postedAt?.getTime()).toBe(1_735_689_600_000);
  });

  it("falls back to applyUrl when hostedUrl is absent", () => {
    const [candidate] = adapter.listJobs(
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

    expect(adapter.listJobs(noId, board({ ats: "lever" }))).toEqual([]);
    expect(adapter.listJobs(noTitle, board({ ats: "lever" }))).toEqual([]);
    expect(adapter.listJobs(noUrl, board({ ats: "lever" }))).toEqual([]);
  });

  it.each(GARBAGE)("returns [] rather than throwing on garbage input: %p", (garbage) => {
    expect(() => adapter.listJobs(garbage, board({ ats: "lever" }))).not.toThrow();
    expect(adapter.listJobs(garbage, board({ ats: "lever" }))).toEqual([]);
  });
});

describe("ashbyAdapter", () => {
  const adapter = ashbyAdapter;
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
    const [candidate] = adapter.listJobs(wellFormed, board({ ats: "ashby" }));

    expect(candidate).toBeDefined();
    expect(candidate!.externalId).toBe("xyz-789");
    expect(candidate!.title).toBe("Backend Engineer");
    expect(candidate!.url).toBe("https://jobs.ashbyhq.com/acme/xyz-789");
    expect(candidate!.location).toBe("Amsterdam, Netherlands");
    expect(candidate!.postedAt?.toISOString()).toBe("2026-08-01T10:00:00.000Z");
  });

  it("carries a real description, unlike Greenhouse", () => {
    const [candidate] = adapter.listJobs(wellFormed, board({ ats: "ashby" }));
    expect(candidate!.description).toBe("Full plain-text description.");
  });

  it("falls back to applyUrl when jobUrl is absent", () => {
    const [candidate] = adapter.listJobs(
      { jobs: [{ ...wellFormed.jobs[0]!, jobUrl: "" }] },
      board({ ats: "ashby" }),
    );
    expect(candidate!.url).toBe("https://jobs.ashbyhq.com/acme/xyz-789/apply");
  });

  it("excludes rows with isListed: false — unlisted drafts are not applyable", () => {
    const unlisted = { jobs: [{ ...wellFormed.jobs[0]!, isListed: false }] };
    expect(adapter.listJobs(unlisted, board({ ats: "ashby" }))).toEqual([]);
  });

  it("keeps a row with isListed: true and one with isListed absent", () => {
    const noFlag = { jobs: [{ ...wellFormed.jobs[0]!, isListed: undefined }] };
    expect(adapter.listJobs(noFlag, board({ ats: "ashby" }))).toHaveLength(1);
    expect(adapter.listJobs(wellFormed, board({ ats: "ashby" }))).toHaveLength(1);
  });

  it("skips a row missing an id, a title, or a URL", () => {
    const base = wellFormed.jobs[0]!;
    const noId = { jobs: [{ ...base, id: undefined }] };
    const noTitle = { jobs: [{ ...base, title: "" }] };
    const noUrl = { jobs: [{ ...base, jobUrl: "", applyUrl: "" }] };

    expect(adapter.listJobs(noId, board({ ats: "ashby" }))).toEqual([]);
    expect(adapter.listJobs(noTitle, board({ ats: "ashby" }))).toEqual([]);
    expect(adapter.listJobs(noUrl, board({ ats: "ashby" }))).toEqual([]);
  });

  it.each(GARBAGE)("returns [] rather than throwing on garbage input: %p", (garbage) => {
    expect(() => adapter.listJobs(garbage, board({ ats: "ashby" }))).not.toThrow();
    expect(adapter.listJobs(garbage, board({ ats: "ashby" }))).toEqual([]);
  });
});

describe("recruiteeAdapter", () => {
  const adapter = recruiteeAdapter;
  // Field names and shapes verified live against a real board 2026-08-20
  // (dalsem.recruitee.com) — not guessed from documentation.
  const wellFormed = {
    offers: [
      {
        id: 2636955,
        title: "Senior Elektra Engineer",
        careers_url: "https://werkenbijdalsem.nl/o/senior-elektra-engineer",
        careers_apply_url: "https://werkenbijdalsem.nl/o/senior-elektra-engineer/c/new",
        location: "Den Hoorn, Zuid-Holland, Nederland",
        published_at: "2026-06-12 07:28:07 UTC",
        description: "<p><strong>Vacature</strong></p><p>We use C++.</p>",
        requirements: "<p>5 years experience required.</p>",
        status: "published",
      },
    ],
  };

  it("maps a well-formed payload to the right fields", () => {
    const [candidate] = adapter.listJobs(wellFormed, board({ ats: "recruitee" }));

    expect(candidate).toBeDefined();
    expect(candidate!.externalId).toBe("2636955");
    expect(candidate!.title).toBe("Senior Elektra Engineer");
    // The posting page, not the form that skips straight to applying.
    expect(candidate!.url).toBe("https://werkenbijdalsem.nl/o/senior-elektra-engineer");
    expect(candidate!.location).toBe("Den Hoorn, Zuid-Holland, Nederland");
    expect(candidate!.postedAt?.toISOString()).toBe("2026-06-12T07:28:07.000Z");
  });

  it("concatenates description and requirements, HTML-decoded", () => {
    const [candidate] = adapter.listJobs(wellFormed, board({ ats: "recruitee" }));
    // Tags become whitespace, not nothing — "We use C++." and "5 years" must
    // never glue to an adjacent word the way a naive strip would.
    expect(candidate!.description).toContain("We use C++.");
    expect(candidate!.description).toContain("5 years experience required.");
  });

  it("falls back to careers_apply_url when careers_url is absent", () => {
    const [candidate] = adapter.listJobs(
      { offers: [{ ...wellFormed.offers[0]!, careers_url: "" }] },
      board({ ats: "recruitee" }),
    );
    expect(candidate!.url).toBe("https://werkenbijdalsem.nl/o/senior-elektra-engineer/c/new");
  });

  it("excludes a row with a non-published status", () => {
    const draft = { offers: [{ ...wellFormed.offers[0]!, status: "draft" }] };
    expect(adapter.listJobs(draft, board({ ats: "recruitee" }))).toEqual([]);
  });

  it("keeps a row with status absent — the endpoint is public and unauthenticated", () => {
    const noStatus = { offers: [{ ...wellFormed.offers[0]!, status: undefined }] };
    expect(adapter.listJobs(noStatus, board({ ats: "recruitee" }))).toHaveLength(1);
  });

  it("skips a row missing an id, a title, or a URL", () => {
    const base = wellFormed.offers[0]!;
    const noId = { offers: [{ ...base, id: undefined }] };
    const noTitle = { offers: [{ ...base, title: "" }] };
    const noUrl = { offers: [{ ...base, careers_url: "", careers_apply_url: "" }] };

    expect(adapter.listJobs(noId, board({ ats: "recruitee" }))).toEqual([]);
    expect(adapter.listJobs(noTitle, board({ ats: "recruitee" }))).toEqual([]);
    expect(adapter.listJobs(noUrl, board({ ats: "recruitee" }))).toEqual([]);
  });

  it.each(GARBAGE)("returns [] rather than throwing on garbage input: %p", (garbage) => {
    expect(() => adapter.listJobs(garbage, board({ ats: "recruitee" }))).not.toThrow();
    expect(adapter.listJobs(garbage, board({ ats: "recruitee" }))).toEqual([]);
  });
});

describe("decodeJobBody", () => {
  it("turns a tag boundary into whitespace, never nothing", () => {
    // The defect this exists to prevent: stripping `</p><p>` to "" glues the
    // last word of one paragraph to the first of the next, and "5 years"
    // arriving as "experience5 years" is invisible to the years regex.
    expect(decodeJobBody("<p>experience</p><p>5 years</p>")).toBe("experience 5 years");
  });

  it("decodes HTML entities, &amp; last so it cannot double-decode", () => {
    expect(decodeJobBody("Sales &amp; Marketing")).toBe("Sales & Marketing");
    expect(decodeJobBody("&amp;lt;script&amp;gt;")).toBe("&lt;script&gt;");
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
