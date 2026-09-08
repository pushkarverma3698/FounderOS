/**
 * `countPostings` — why HTTP 200 is not evidence of a board.
 *
 * Found while verifying the funding-grower crash fix (2026-09-08). With the
 * crash removed the sweep completed and reported "boards discovered 12
 * (100.00% hit rate)" from twelve slugs guessed off funding headlines. A 100%
 * hit rate is not discovery; it is a broken liveness signal. Two platforms
 * answer 200 for a tenant that does not exist:
 *
 *   SmartRecruiters → 200 {"totalFound":0,"content":[]}
 *   BambooHR        → 200 + 43 KB of its own marketing homepage
 *
 * The probe checked only `res.ok`, so every candidate was a hit — and because
 * the sweep had been crashing before it could write anything, nothing had ever
 * surfaced it. Fixing the crash alone would have started writing a dozen junk
 * boards a night into the registry the 30-minute poll reads.
 *
 * Every fixture below is a real response shape captured from the live endpoint
 * on 2026-09-08, truncated. The negative cases matter as much as the positive
 * ones: Personio serves a REAL board as XML, so "not JSON ⇒ not a board" would
 * have deleted a working platform to fix a different one.
 */

import { describe, it, expect } from "vitest";
import { countPostings } from "../../../src/tools/jobhunt/board-probe.js";

describe("countPostings — a tenant that does not exist", () => {
  it("reads SmartRecruiters' empty 200 as zero postings", () => {
    expect(countPostings('{"offset":0,"limit":100,"totalFound":0,"content":[]}')).toBe(0);
  });

  it("reads BambooHR's marketing homepage as zero postings", () => {
    const page = '<!DOCTYPE html>\n<html>\n  <head>\n    <title>BambooHR: The Complete HR Software</title>';
    expect(countPostings(page)).toBe(0);
  });

  it("reads an <html>-led page with no doctype as zero too", () => {
    expect(countPostings('<html lang="en"><body>Nothing here</body></html>')).toBe(0);
  });
});

describe("countPostings — a real board", () => {
  it("counts SmartRecruiters postings", () => {
    expect(countPostings('{"totalFound":1,"content":[{"id":"744000137413079"}]}')).toBe(1);
  });

  it("counts BambooHR's result array", () => {
    expect(countPostings('{"meta":{"totalCount":1},"result":[{"id":"165"}]}')).toBe(1);
  });

  it("counts a Teamtailor JSON Feed's items", () => {
    expect(
      countPostings('{"version":"https://jsonfeed.org/version/1.1","title":"The Acorn Group","items":[{},{}]}'),
    ).toBe(2);
  });

  it("counts a bare array of postings", () => {
    expect(countPostings("[{},{},{}]")).toBe(3);
  });

  it("leaves Personio's XML board unjudged rather than calling it dead", () => {
    // null = "shape not recognised" — the caller treats it as evidence present,
    // so a platform we cannot parse keeps the behaviour it had.
    expect(countPostings('<?xml version="1.0"?><workzag-jobs><position><id>26587</id></position></workzag-jobs>')).toBeNull();
  });

  it("leaves any other unparseable body unjudged", () => {
    expect(countPostings("Not Found")).toBeNull();
    expect(countPostings("")).toBeNull();
  });
});
