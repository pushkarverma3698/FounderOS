/**
 * Unit tests — turning stored rows into what the analyzer reads.
 * ==============================================================
 * The mapping between the database and the pure analyzer, tested with array
 * literals. Every URL below is a real posting-URL SHAPE taken from
 * tests/unit/jobhunt/apply-url.test.ts (which took them from production on
 * 2026-08-21), so the platform attribution is held to real data, not invented
 * shapes.
 *
 * WHY THIS MATTERS. The analyzer's two implementation findings are only as true as
 * the platform a row is attributed to and the form-link verdict it carries. An
 * own-domain (white-labelled) posting must never be counted against a platform, and
 * the verdict must be the SAME function `/draft` uses, or the finding measures
 * something the founder never experiences.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FREE_LANE_FEED,
  PLATFORM_HOST_SUFFIXES,
  platformOfUrl,
  toActivityRow,
  toHeartbeatRow,
  toIngestRunRow,
  toNewPostingRow,
} from "../../../src/evolution/jobhunt-rows.js";
import { ADAPTER_SOURCE_PATHS } from "../../../src/evolution/analyzers/jobhunt.js";
import { ADAPTERS } from "../../../src/tools/jobhunt/adapters/index.js";
import { FREE_ATS_PLATFORMS } from "../../../src/tools/jobhunt/free-boards.js";
import { getApplyUrl } from "../../../src/tools/jobhunt/apply-packet.js";

const CREATED = new Date("2026-09-28T10:00:00Z");

describe("the platform table", () => {
  it("covers exactly the platforms that have an adapter, so a new adapter cannot ship unmonitored", () => {
    expect(Object.keys(PLATFORM_HOST_SUFFIXES).sort()).toEqual(Object.keys(ADAPTERS).sort());
    expect(Object.keys(PLATFORM_HOST_SUFFIXES).sort()).toEqual([...FREE_ATS_PLATFORMS].sort());
    expect(Object.keys(ADAPTER_SOURCE_PATHS).sort()).toEqual(Object.keys(PLATFORM_HOST_SUFFIXES).sort());
  });

  it("names the feed the free lane really writes to job_ingest_runs", () => {
    // ingest-ledger.ts types it, free-ingest.ts writes it; if either moves this fails instead of the check going blind.
    const writer = readFileSync(join(process.cwd(), "src/tools/jobhunt/free-ingest.ts"), "utf8");
    expect(writer).toContain(`feed: "${FREE_LANE_FEED}"`);
  });
});

describe("platformOfUrl", () => {
  const cases: Array<[string, string]> = [
    ["https://job-boards.greenhouse.io/zscaler/jobs/5215314007", "greenhouse"],
    ["https://job-boards.eu.greenhouse.io/workwize/jobs/4938710101", "greenhouse"],
    ["https://jobs.lever.co/extremenetworks/0100b069-56f7-4aec-96b8-c34cae660a5d", "lever"],
    ["https://jobs.ashbyhq.com/lemonade/250f4be5-c5e0-4973-bc12-c9682d40ed8d", "ashby"],
    ["https://ockto.recruitee.com/o/senior-site-reliability-engineer", "recruitee"],
    ["https://jobs.smartrecruiters.com/servicenow/744000144691979", "smartrecruiters"],
    ["https://apply.workable.com/acme/j/A1B2C3D4E5/", "workable"],
    // Account-less Workable short links carry no token, so the recogniser cannot see them; the host still can.
    ["https://apply.workable.com/j/A1B2C3D4E5", "workable"],
  ];

  it.each(cases)("%s -> %s", (url, platform) => {
    expect(platformOfUrl(url)).toBe(platform);
  });

  it("attributes a platform-host URL the recogniser cannot read to that platform by its host", () => {
    // This is exactly the row apply-link-unrecognised counts: on the platform's domain, no token found.
    expect(platformOfUrl("https://boards.greenhouse.io/")).toBe("greenhouse");
    expect(platformOfUrl("https://something.myworkdayjobs.com/")).toBe("workday");
  });

  it("does NOT attribute an employer's own-domain posting to any platform", () => {
    // The white-labelled case the 09-28 audit measured as 17.8% of postings, by design.
    expect(platformOfUrl("https://www.databricks.com/company/careers/open-positions/job?gh_jid=6012345")).toBeNull();
    expect(platformOfUrl("https://careers.brenger.nl/o/ops-lead")).toBeNull();
  });

  it("does not mistake a lookalike host for a platform", () => {
    expect(platformOfUrl("https://notgreenhouse.io/jobs/1")).toBeNull();
    expect(platformOfUrl("https://greenhouse.io.evil.example/jobs/1")).toBeNull();
  });

  it("is total: empty, malformed and non-string input never throw", () => {
    expect(platformOfUrl("")).toBeNull();
    expect(platformOfUrl("not a url")).toBeNull();
    expect(platformOfUrl(undefined as unknown as string)).toBeNull();
  });
});

describe("toNewPostingRow", () => {
  const raw = (url: string | null, over: Record<string, unknown> = {}) => ({
    createdAt: CREATED as Date | null,
    company: "servicenow",
    title: "Senior FP&A Analyst",
    url,
    ...over,
  });

  it("carries the verdict of the SAME recogniser /draft uses (parity with getApplyUrl)", () => {
    const urls = [
      "https://job-boards.greenhouse.io/zscaler/jobs/5215314007",
      "https://jobs.smartrecruiters.com/servicenow/744000144691979",
      "https://apply.workable.com/j/A1B2C3D4E5",
      "https://apply.workable.com/acme/j/A1B2C3D4E5/",
      "https://www.databricks.com/company/careers?gh_jid=1",
      "https://careers.brenger.nl/o/ops-lead",
      "https://boards.greenhouse.io/",
      "https://random.example.test/job/1",
    ];
    for (const url of urls) {
      expect(toNewPostingRow(raw(url))!.hasFormLink, url).toBe(getApplyUrl(url, "servicenow") !== null);
    }
  });

  it("a platform-host URL with a form link is recognised; one the recogniser misses is not", () => {
    expect(toNewPostingRow(raw("https://jobs.lever.co/acme/0100b069-56f7-4aec-96b8-c34cae660a5d"))).toMatchObject({
      platform: "lever",
      hasFormLink: true,
    });
    expect(toNewPostingRow(raw("https://boards.greenhouse.io/"))).toMatchObject({
      platform: "greenhouse",
      hasFormLink: false,
    });
  });

  it("an own-domain posting has no platform and no form link, and is therefore never counted against anyone", () => {
    expect(toNewPostingRow(raw("https://careers.brenger.nl/o/ops-lead"))).toMatchObject({
      platform: null,
      hasFormLink: false,
    });
  });

  it("keeps the fields the evidence quotes, unchanged", () => {
    expect(toNewPostingRow(raw("https://jobs.lever.co/acme/0100b069"))).toMatchObject({
      createdAt: CREATED,
      company: "servicenow",
      title: "Senior FP&A Analyst",
      url: "https://jobs.lever.co/acme/0100b069",
    });
  });

  it("a row with no URL or no date cannot be windowed or quoted, so it is left out rather than guessed", () => {
    expect(toNewPostingRow(raw(null))).toBeNull();
    expect(toNewPostingRow(raw("https://jobs.lever.co/acme/1", { createdAt: null }))).toBeNull();
  });
});

describe("toIngestRunRow", () => {
  it("keeps the failure summary, and drops a run with no timestamp", () => {
    expect(toIngestRunRow({ createdAt: CREATED, error: "3 board(s) failed: ashby HTTP 429 ×3" })).toEqual({
      createdAt: CREATED,
      error: "3 board(s) failed: ashby HTTP 429 ×3",
    });
    expect(toIngestRunRow({ createdAt: null, error: null })).toBeNull();
  });
});

describe("toHeartbeatRow", () => {
  const names = new Map([["wife-nl-finance", "Tashi Goyal"]]);
  const funnel = { seen: 900, undated: 0, stale: 0, offTrack: 0, offMarket: 0, known: 900, bodyless: 0, screened: 0 };

  it("names the candidate from the profile registry and keeps the streak and the funnel", () => {
    expect(toHeartbeatRow({ profileId: "wife-nl-finance", zeroPassStreak: 9, lastFunnel: funnel }, names)).toEqual({
      profileId: "wife-nl-finance",
      candidateName: "Tashi Goyal",
      zeroPassStreak: 9,
      lastFunnel: funnel,
    });
  });

  it("a profile the registry does not know is still reported, by id", () => {
    expect(toHeartbeatRow({ profileId: "ghost", zeroPassStreak: 7, lastFunnel: null }, names).candidateName).toBeUndefined();
  });

  it("a funnel of an unrecognised shape is dropped, not trusted", () => {
    expect(toHeartbeatRow({ profileId: "wife-nl-finance", zeroPassStreak: 7, lastFunnel: { seen: "lots" } }, names).lastFunnel).toBeNull();
  });
});

describe("toActivityRow", () => {
  const names = new Map([["wife-nl-finance", "Tashi Goyal"]]);

  it("reads the counts Postgres returns as strings (count(*) is a bigint)", () => {
    expect(
      toActivityRow({ profileId: "wife-nl-finance", doToday: "28", stretch: "14", ask: "20", applied: "0", skipped: "0" }, names),
    ).toEqual({
      profileId: "wife-nl-finance",
      candidateName: "Tashi Goyal",
      doToday: 28,
      stretch: 14,
      ask: 20,
      applied: 0,
      skipped: 0,
    });
  });

  it("throws on a count that is not a number, instead of letting one NaN poison every comparison downstream", () => {
    expect(() =>
      toActivityRow({ profileId: "wife-nl-finance", doToday: "n/a", stretch: 0, ask: 0, applied: 0, skipped: 0 }, names),
    ).toThrow(/doToday.*not a count/);
    expect(() =>
      toActivityRow({ profileId: "wife-nl-finance", doToday: -1, stretch: 0, ask: 0, applied: 0, skipped: 0 }, names),
    ).toThrow(/not a count/);
  });
});
