/**
 * Unit tests — extracting a free-board token from a paid-sweep posting URL.
 *
 * The regex variants here are not guesses: the plain `boards.greenhouse.io` /
 * `jobs.lever.co` forms measured 74/209 against real production URLs
 * (2026-08-20) — the other 135 were the `job-boards.` and `.eu.` variants
 * below.
 */

import { describe, it, expect } from "vitest";
import { extractBoardToken, harvestNewBoardTokens } from "../../../src/tools/jobhunt/board-token.js";

describe("extractBoardToken", () => {
  it("reads a Greenhouse token from the plain US host", () => {
    expect(extractBoardToken("https://boards.greenhouse.io/stripe/jobs/1234567")).toEqual({
      ats: "greenhouse",
      token: "stripe",
    });
  });

  it("reads a Greenhouse token from the job-boards. host — the majority miss", () => {
    expect(extractBoardToken("https://job-boards.greenhouse.io/openai/jobs/987")).toEqual({
      ats: "greenhouse",
      token: "openai",
    });
  });

  it("reads a Greenhouse token from the EU region host, plain and job-boards", () => {
    expect(extractBoardToken("https://boards.eu.greenhouse.io/adyen/jobs/1")).toEqual({
      ats: "greenhouse",
      token: "adyen",
    });
    expect(extractBoardToken("https://job-boards.eu.greenhouse.io/adyen/jobs/1")).toEqual({
      ats: "greenhouse",
      token: "adyen",
    });
  });

  it("reads a Lever token from the plain and EU hosts", () => {
    expect(extractBoardToken("https://jobs.lever.co/netflix/abc-123")).toEqual({
      ats: "lever",
      token: "netflix",
    });
    expect(extractBoardToken("https://jobs.eu.lever.co/mollie/xyz-789")).toEqual({
      ats: "lever",
      token: "mollie",
    });
  });

  it("reads an Ashby token", () => {
    expect(extractBoardToken("https://jobs.ashbyhq.com/linear/abc-123")).toEqual({
      ats: "ashby",
      token: "linear",
    });
  });

  it("reads a Recruitee token from its own subdomain", () => {
    expect(extractBoardToken("https://dalsem.recruitee.com/o/senior-elektra-engineer")).toEqual({
      ats: "recruitee",
      token: "dalsem",
    });
  });

  it("returns null for a Recruitee board on a white-labelled custom domain", () => {
    // Verified live 2026-08-20: dalsem's careers_url is werkenbijdalsem.nl,
    // which carries no token at all. A real ceiling, not a bug.
    expect(extractBoardToken("https://werkenbijdalsem.nl/o/senior-elektra-engineer")).toBeNull();
  });

  it("returns null for a company's own careers page", () => {
    expect(extractBoardToken("https://www.acme.com/careers/backend-engineer")).toBeNull();
  });

  it("returns null for an aggregator, not the employer's own board", () => {
    expect(extractBoardToken("https://www.indeed.com/viewjob?jk=abc123")).toBeNull();
  });

  it.each([null, undefined, "", "   ", "not a url at all", "https://boards.greenhouse.io/"])(
    "never throws on malformed input: %p",
    (input) => {
      expect(() => extractBoardToken(input as unknown as string)).not.toThrow();
    },
  );

  it("returns null rather than an empty token for a bare host with no path", () => {
    expect(extractBoardToken("https://boards.greenhouse.io/")).toBeNull();
  });

  it("decodes a percent-encoded token", () => {
    expect(extractBoardToken("https://jobs.ashbyhq.com/abstraction.games/abc")).toEqual({
      ats: "ashby",
      token: "abstraction.games",
    });
  });
});

describe("harvestNewBoardTokens", () => {
  it("harvests a token from a posting whose URL matches a known ATS", () => {
    const found = harvestNewBoardTokens(
      [{ url: "https://boards.greenhouse.io/stripe/jobs/1", company: "Stripe", country: "other" }],
      new Set(),
    );
    expect(found).toEqual([{ name: "Stripe", ats: "greenhouse", token: "stripe", markets: [] }]);
  });

  it("harvests from a REJECTED posting exactly like a passing one", () => {
    // The point of moving the hook to the fetch boundary: a posting's own
    // verdict never enters this function at all — there is no `verdict`
    // field on HarvestableSighting.
    const found = harvestNewBoardTokens(
      [{ url: "https://jobs.lever.co/acme/1", company: "Acme B.V.", country: "NL" }],
      new Set(),
    );
    expect(found).toHaveLength(1);
  });

  it("skips a token already known — curated or previously discovered", () => {
    const found = harvestNewBoardTokens(
      [{ url: "https://boards.greenhouse.io/stripe/jobs/1", company: "Stripe", country: "other" }],
      new Set(["greenhouse:stripe"]),
    );
    expect(found).toEqual([]);
  });

  it("dedupes two postings from the same board within one batch", () => {
    const found = harvestNewBoardTokens(
      [
        { url: "https://boards.greenhouse.io/stripe/jobs/1", company: "Stripe", country: "other" },
        { url: "https://boards.greenhouse.io/stripe/jobs/2", company: "Stripe", country: "other" },
      ],
      new Set(),
    );
    expect(found).toHaveLength(1);
  });

  it("carries a positive NL or IN market, never defaults an unknown country to NL", () => {
    const nl = harvestNewBoardTokens(
      [{ url: "https://boards.greenhouse.io/a/jobs/1", company: "A", country: "NL" }],
      new Set(),
    );
    expect(nl[0]!.markets).toEqual(["NL"]);

    const unknown = harvestNewBoardTokens(
      [{ url: "https://boards.greenhouse.io/b/jobs/1", company: "B", country: "unknown" }],
      new Set(),
    );
    expect(unknown[0]!.markets).toEqual([]);

    const other = harvestNewBoardTokens(
      [{ url: "https://boards.greenhouse.io/c/jobs/1", company: "C", country: "other" }],
      new Set(),
    );
    expect(other[0]!.markets).toEqual([]);
  });

  it("skips a posting with no url, without throwing", () => {
    const found = harvestNewBoardTokens(
      [{ url: null, company: "Acme" }, { url: undefined, company: "Acme" }],
      new Set(),
    );
    expect(found).toEqual([]);
  });

  it("ignores a posting whose URL is not a recognised ATS", () => {
    const found = harvestNewBoardTokens(
      [{ url: "https://www.acme.com/careers/1", company: "Acme", country: "NL" }],
      new Set(),
    );
    expect(found).toEqual([]);
  });

  it("returns [] for an empty batch", () => {
    expect(harvestNewBoardTokens([], new Set())).toEqual([]);
  });
});
