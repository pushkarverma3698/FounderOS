/**
 * Unit tests — Personio as a first-class free-lane platform.
 *
 * Every switch a new platform has to appear in, asserted rather than assumed.
 * The 2026-08-21 SmartRecruiters note in free-ats-endpoints.ts records what a
 * missed branch costs: 145 boards polling cleanly and contributing nothing.
 */

import { describe, it, expect } from "vitest";

import { boardUrl, jobBodyUrl, applyUrlFor, WIRE_FORMAT } from "../../../src/tools/jobhunt/free-ats-endpoints.js";
import { extractBoardToken } from "../../../src/tools/jobhunt/board-token.js";
import { FREE_MAPPERS } from "../../../src/tools/jobhunt/free-ats-mappers.js";
import { PLATFORM_CONCURRENCY } from "../../../src/tools/jobhunt/free-ats-source.js";
import { FREE_ATS_PLATFORMS, type FreeBoard } from "../../../src/tools/jobhunt/free-boards.js";

const board: FreeBoard = {
  name: "1KOMMA5",
  ats: "personio",
  token: "1komma5grad",
  markets: ["NL"],
};

describe("personio — platform registration", () => {
  it("is a known platform with a mapper and a concurrency limit", () => {
    expect(FREE_ATS_PLATFORMS).toContain("personio");
    expect(FREE_MAPPERS.personio).toBeTypeOf("function");
    expect(PLATFORM_CONCURRENCY.personio).toBeGreaterThan(0);
  });

  it("polls /xml, never search.json", () => {
    // search.json answers 200 with every posting and an empty description on
    // all of them — the failure would look like a healthy board with no bodies.
    expect(boardUrl(board)).toBe("https://1komma5grad.jobs.personio.com/xml");
    expect(WIRE_FORMAT.personio).toBe("xml");
  });

  it("needs no hydration request — the board feed already carries every body", () => {
    expect(jobBodyUrl(board, "781758")).toBeNull();
  });

  it("recovers the token from a posting URL on either host", () => {
    expect(extractBoardToken("https://1komma5grad.jobs.personio.com/job/781758")).toEqual({
      ats: "personio",
      token: "1komma5grad",
    });
    expect(extractBoardToken("https://acme.jobs.personio.de/job/1")).toEqual({
      ats: "personio",
      token: "acme",
    });
  });

  it("does not register the bare marketing host as a board", () => {
    // `jobs.personio.com` would otherwise capture the token "jobs" and poll
    // nothing forever — the defect Workable's `/j/` segment also guards.
    expect(extractBoardToken("https://jobs.personio.com/anything")).toBeNull();
  });

  it("points the apply button at the posting itself rather than inventing a route", () => {
    const url = "https://1komma5grad.jobs.personio.com/job/781758";
    expect(applyUrlFor(url)).toBe(url);
  });
});

describe("mapPersonioPositions", () => {
  const FEED = `<workzag-jobs><position>
    <id>781758</id><office>Amsterdam</office><name>Platform Engineer</name>
    <jobDescriptions><jobDescription><name>Role</name>
      <value><![CDATA[<p>5 years of experience with Node.</p>]]></value>
    </jobDescription></jobDescriptions>
    <createdAt>2026-08-11T12:53:30+00:00</createdAt>
  </position></workzag-jobs>`;

  it("builds a linkable candidate the screener can act on", () => {
    const [row] = FREE_MAPPERS.personio(FEED, board);
    expect(row).toMatchObject({
      externalId: "781758",
      title: "Platform Engineer",
      location: "Amsterdam",
      url: "https://1komma5grad.jobs.personio.com/job/781758",
    });
    expect(row?.postedAt?.toISOString()).toBe("2026-08-11T12:53:30.000Z");
  });

  it("delivers the body as prose the gates can read", () => {
    const [row] = FREE_MAPPERS.personio(FEED, board);
    expect(row?.description).toContain("5 years of experience");
    expect(row?.description).not.toContain("<p>");
  });

  it("drops a position with no title rather than emitting an unreadable row", () => {
    expect(FREE_MAPPERS.personio(FEED.replace("<name>Platform Engineer</name>", ""), board)).toHaveLength(0);
  });

  it("returns nothing when handed a non-string payload", () => {
    // A wire-format mismatch is a bug in WIRE_FORMAT, not a bad board — it must
    // not throw and take the rest of the sweep's boards with it.
    expect(FREE_MAPPERS.personio({ jobs: [] }, board)).toEqual([]);
    expect(FREE_MAPPERS.personio(null, board)).toEqual([]);
  });
});
