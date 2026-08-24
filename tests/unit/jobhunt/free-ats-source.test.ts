/**
 * Unit tests — the free lane's network layer (fetch stubbed, no real network).
 *
 * THREE FAILURE RULES THIS FILE PINS DOWN: a board that fails is counted, never
 * skipped silently; one board's failure never aborts the sweep; and a sweep
 * where every board failed still returns normally so the caller can say "the
 * lane is broken" instead of "the market is quiet".
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const {
  boardUrl,
  jobBodyUrl,
  fetchBoard,
  sweepBoards,
  decodeJobBody,
  PLATFORM_CONCURRENCY,
} = await import("../../../src/tools/jobhunt/free-ats-source.js");
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

function okResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

/** Retryable statuses now cost real backoff; these tests assert outcomes, not delays. */
const noSleep = { sleep: async () => {} };

function errorResponse(status: number) {
  return { ok: false, status, json: async () => ({}), body: { cancel: async () => {} } };
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe("boardUrl", () => {
  it("builds the Greenhouse URL", () => {
    expect(boardUrl(board({ ats: "greenhouse", token: "acme" }))).toBe(
      "https://boards-api.greenhouse.io/v1/boards/acme/jobs",
    );
  });

  it("builds the Lever URL", () => {
    expect(boardUrl(board({ ats: "lever", token: "zeeco" }))).toBe(
      "https://api.lever.co/v0/postings/zeeco?mode=json",
    );
  });

  it("builds the Ashby URL", () => {
    expect(boardUrl(board({ ats: "ashby", token: "acme" }))).toBe(
      "https://api.ashbyhq.com/posting-api/job-board/acme",
    );
  });

  it("URL-encodes a token containing a dot and mixed case", () => {
    const url = boardUrl(board({ ats: "ashby", token: "Abstraction.Games" }));
    expect(url).toBe("https://api.ashbyhq.com/posting-api/job-board/Abstraction.Games");
  });

  it("URL-encodes a token containing a character that must be escaped", () => {
    // A raw slash would otherwise rewrite the path it is supposed to be a
    // segment of.
    const url = boardUrl(board({ ats: "greenhouse", token: "foo/bar" }));
    expect(url).toBe("https://boards-api.greenhouse.io/v1/boards/foo%2Fbar/jobs");
  });
});

describe("jobBodyUrl (greenhouse)", () => {
  it("builds the per-posting URL correctly", () => {
    expect(jobBodyUrl(board({ ats: "greenhouse", token: "acme" }), "12345")).toBe(
      "https://boards-api.greenhouse.io/v1/boards/acme/jobs/12345",
    );
  });

  it("URL-encodes both the token and the externalId", () => {
    expect(jobBodyUrl(board({ ats: "greenhouse", token: "foo/bar" }), "12 34")).toBe(
      "https://boards-api.greenhouse.io/v1/boards/foo%2Fbar/jobs/12%2034",
    );
  });
});

describe("fetchBoard", () => {
  it("returns { ok: false, error } on a non-2xx response — never throws", async () => {
    // Persistent, not `Once`: a 500 is retried (free-board-retry.test.ts), so a
    // single queued response would leave the second attempt reading `undefined`.
    mockFetch.mockResolvedValue(errorResponse(500));

    const result = await fetchBoard(board(), noSleep);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("500");
  });

  it("returns { ok: false, error } on a network rejection — never throws", async () => {
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await fetchBoard(board(), noSleep);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("ECONNREFUSED");
  });

  it("returns { ok: false, error } on malformed JSON — never throws", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON at position 0");
      },
    });

    const result = await fetchBoard(board(), noSleep);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unexpected token/i);
  });

  it("returns ok: true with mapped candidates on a well-formed response", async () => {
    mockFetch.mockResolvedValueOnce(
      okResponse({
        jobs: [
          {
            id: 1,
            title: "Backend Engineer",
            absolute_url: "https://boards.greenhouse.io/acme/jobs/1",
            location: { name: "Amsterdam" },
            first_published: "2026-08-01T00:00:00Z",
          },
        ],
      }),
    );

    const result = await fetchBoard(board());

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.candidates).toHaveLength(1);
  });
});

describe("sweepBoards", () => {
  it("isolates failures — successful candidates AND one named failure per failed board come back", async () => {
    const boards = [
      board({ ats: "greenhouse", token: "good-gh" }),
      board({ ats: "lever", token: "rotated-token" }),
      board({ ats: "ashby", token: "good-ashby" }),
    ];

    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("good-gh")) {
        return okResponse({
          jobs: [
            {
              id: 1,
              title: "Backend Engineer",
              absolute_url: "https://x.com/1",
              location: { name: "Amsterdam" },
              first_published: "2026-08-01T00:00:00Z",
            },
          ],
        });
      }
      if (url.includes("rotated-token")) {
        return errorResponse(404);
      }
      if (url.includes("good-ashby")) {
        return okResponse({
          jobs: [
            {
              id: "2",
              title: "Frontend Engineer",
              jobUrl: "https://x.com/2",
              location: "Bangalore",
              publishedAt: "2026-08-01T00:00:00Z",
              isListed: true,
            },
          ],
        });
      }
      throw new Error(`unexpected url in test: ${url}`);
    });

    const sweep = await sweepBoards(boards);

    expect(sweep.candidates).toHaveLength(2);
    expect(sweep.boardsPolled).toBe(3);
    expect(sweep.failures).toHaveLength(1);
    // Named so a rotated token is findable — platform and token both present.
    expect(sweep.failures[0]).toContain("lever/rotated-token");
    expect(sweep.failures[0]).toContain("404");
  });

  it("with EVERY board failing, returns normally with zero candidates and a full failure list — never throws", async () => {
    const boards = [
      board({ ats: "greenhouse", token: "a" }),
      board({ ats: "lever", token: "b" }),
      board({ ats: "ashby", token: "c" }),
    ];
    mockFetch.mockResolvedValue(errorResponse(500));

    const sweep = await sweepBoards(boards);

    expect(sweep.candidates).toEqual([]);
    expect(sweep.failures).toHaveLength(3);
    expect(sweep.boardsPolled).toBe(3);
    expect(sweep.failures.some((f) => f.includes("greenhouse/a"))).toBe(true);
    expect(sweep.failures.some((f) => f.includes("lever/b"))).toBe(true);
    expect(sweep.failures.some((f) => f.includes("ashby/c"))).toBe(true);
  });

  it("one board's failure does not abort the sweep for the others", async () => {
    const boards = Array.from({ length: 5 }, (_, i) => board({ ats: "greenhouse", token: `t${i}` }));

    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("t2")) return errorResponse(500);
      return okResponse({ jobs: [] });
    });

    const sweep = await sweepBoards(boards);

    expect(sweep.boardsPolled).toBe(5);
    expect(sweep.failures).toHaveLength(1);
    expect(sweep.failures[0]).toContain("t2");
  });

  it("never exceeds a platform's own in-flight limit", async () => {
    // Recruitee answers HTTP 429 to a burst of eight (measured 2026-08-20: 34 of
    // 40 sweep failures were Recruitee 429s right after the registry grew to 623).
    // If this cap regresses, a third of the Dutch boards fail on every sweep.
    const inFlight = new Map<string, number>();
    const peak = new Map<string, number>();

    mockFetch.mockImplementation(async (url: string) => {
      const ats = url.includes("recruitee") ? "recruitee" : "greenhouse";
      const now = (inFlight.get(ats) ?? 0) + 1;
      inFlight.set(ats, now);
      peak.set(ats, Math.max(peak.get(ats) ?? 0, now));
      await new Promise((r) => setTimeout(r, 5));
      inFlight.set(ats, now - 1);
      return okResponse(ats === "recruitee" ? { offers: [] } : { jobs: [] });
    });

    await sweepBoards([
      ...Array.from({ length: 12 }, (_, i) => board({ ats: "recruitee", token: `r${i}` })),
      ...Array.from({ length: 12 }, (_, i) => board({ ats: "greenhouse", token: `g${i}` })),
    ]);

    expect(peak.get("recruitee")).toBeLessThanOrEqual(PLATFORM_CONCURRENCY.recruitee);
    expect(peak.get("greenhouse")).toBeLessThanOrEqual(PLATFORM_CONCURRENCY.greenhouse);
    // The platforms must run in parallel, not one group after the other.
    expect(peak.get("greenhouse")).toBeGreaterThan(PLATFORM_CONCURRENCY.recruitee);
  });
});

describe("decodeJobBody", () => {
  it("decodes HTML entities", () => {
    const out = decodeJobBody("Tom &amp; Jerry, &quot;quoted&quot;, it&#39;s&nbsp;great");
    expect(out).toContain("Tom & Jerry");
    expect(out).toContain('"quoted"');
    expect(out).toContain("it's great");
  });

  it("converts tags to WHITESPACE, not nothing — words across tags stay separated", () => {
    // A naive tag-strip would glue the paragraphs into "experience5 years",
    // which the downstream years-of-experience regex would miss entirely.
    const out = decodeJobBody("<p>experience</p><p>5 years</p>");
    expect(out).not.toBe("experience5 years");
    expect(out).toBe("experience 5 years");
  });

  it("collapses runs of whitespace", () => {
    expect(decodeJobBody("a   b\n\nc\t\td")).toBe("a b c d");
  });

  it("decodes &amp; LAST, so &amp;lt; does not become a real tag", () => {
    // Decoding &amp; first would turn "&amp;lt;" into "&lt;" into a literal "<",
    // which the tag-stripping regex would then swallow along with real content.
    const out = decodeJobBody("Salary &amp;lt;100k&amp;gt;");
    expect(out).toBe("Salary &lt;100k&gt;");
  });
});
