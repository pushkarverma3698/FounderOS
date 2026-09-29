/**
 * The apply URL is the one-tap half of an application packet.
 *
 * The failure this guards against is not a crash — it is a plausible-looking
 * link that lands on the wrong page. A `/draft` that delivers a tailored CV and
 * a button pointing at a 404 is worse than one that delivers no button at all,
 * because the founder taps it once, finds nothing, and stops trusting the row.
 *
 * Every URL below is a real posting URL taken from `agents.job_applications` on
 * production, 2026-08-21 — not an invented shape.
 */

import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { getApplyUrl as applyUrlFor } from "../../../src/tools/jobhunt/apply-packet.js";
import { ADAPTERS } from "../../../src/tools/jobhunt/adapters/index.js";

describe("applyUrlFor", () => {
  it("appends the Greenhouse in-page application anchor", () => {
    expect(applyUrlFor("https://job-boards.greenhouse.io/zscaler/jobs/5215314007", "zscaler")).toBe(
      "https://job-boards.greenhouse.io/zscaler/jobs/5215314007#app",
    );
  });

  it("handles the EU Greenhouse host", () => {
    expect(applyUrlFor("https://job-boards.eu.greenhouse.io/workwize/jobs/4938710101", "workwize")).toBe(
      "https://job-boards.eu.greenhouse.io/workwize/jobs/4938710101#app",
    );
  });

  it("appends /apply on Lever", () => {
    expect(
      applyUrlFor("https://jobs.lever.co/extremenetworks/0100b069-56f7-4aec-96b8-c34cae660a5d", "extremenetworks"),
    ).toBe("https://jobs.lever.co/extremenetworks/0100b069-56f7-4aec-96b8-c34cae660a5d/apply");
  });

  it("appends /application on Ashby", () => {
    expect(
      applyUrlFor("https://jobs.ashbyhq.com/lemonade/250f4be5-c5e0-4973-bc12-c9682d40ed8d", "lemonade"),
    ).toBe("https://jobs.ashbyhq.com/lemonade/250f4be5-c5e0-4973-bc12-c9682d40ed8d/application");
  });

  it("appends /c/new on Recruitee", () => {
    expect(applyUrlFor("https://ockto.recruitee.com/o/senior-site-reliability-engineer", "ockto")).toBe(
      "https://ockto.recruitee.com/o/senior-site-reliability-engineer/c/new",
    );
  });

  it("leaves a SmartRecruiters posting alone — the form is on the posting page", () => {
    expect(applyUrlFor("https://jobs.smartrecruiters.com/servicenow/744000144691979", "servicenow")).toBe(
      "https://jobs.smartrecruiters.com/servicenow/744000144691979",
    );
  });

  it("appends /apply on Workable", () => {
    expect(applyUrlFor("https://apply.workable.com/acme/j/A1B2C3D4E5/", "acme")).toBe(
      "https://apply.workable.com/acme/j/A1B2C3D4E5/apply",
    );
  });

  // The three platforms Dutch finance employers mostly run on — ING, Rabobank,
  // NN, PwC, Baker Tilly, RSM and Vistra are all Workday boards. Until
  // 2026-09-28 none of the three was recognised, so every one of their rows
  // got "→ Open the posting" instead of the form, although each adapter already
  // knew the form's address. URLs are real, from the 2026-09-28 NL sweep.
  it("appends /apply on Workday — ING and Rabobank", () => {
    expect(
      applyUrlFor(
        "https://ing.wd3.myworkdayjobs.com/icsnldgen/job/ACT-Amsterdam---Acanthus/Financial-Crime-Compliance-Specialist_REQ-10119952-2",
        "ING",
      ),
    ).toBe(
      "https://ing.wd3.myworkdayjobs.com/icsnldgen/job/ACT-Amsterdam---Acanthus/Financial-Crime-Compliance-Specialist_REQ-10119952-2/apply",
    );
    expect(
      applyUrlFor("https://rabobank.wd3.myworkdayjobs.com/jobs/job/Utrecht-Beneluxlaan-31-33/Finance-Specialist_JR_00145620-1", "Rabobank"),
    ).toBe("https://rabobank.wd3.myworkdayjobs.com/jobs/job/Utrecht-Beneluxlaan-31-33/Finance-Specialist_JR_00145620-1/apply");
  });

  it("appends /applications/new on Teamtailor", () => {
    expect(
      applyUrlFor("https://bearingpointnetherlands.teamtailor.com/jobs/8449394-microsoft-consultant-data-engineering", "BearingPoint"),
    ).toBe("https://bearingpointnetherlands.teamtailor.com/jobs/8449394-microsoft-consultant-data-engineering/applications/new");
  });

  // Workable's widget API hands postings out as account-less short links, and
  // names `<link>/apply` as the form in its own `application_url` field (see the
  // fixture in smartrecruiters-workable.test.ts). No account in the path means
  // no board token, so all 2,636 Workable postings in the 2026-09-28 NL sweep
  // got the posting page instead of the form.
  it("appends /apply to a Workable short link, the form URL Workable itself publishes", () => {
    expect(applyUrlFor("https://apply.workable.com/j/7C893E46E3", "AND Digital")).toBe(
      "https://apply.workable.com/j/7C893E46E3/apply",
    );
    expect(applyUrlFor("https://apply.workable.com/j/7C893E46E3/apply", "AND Digital")).toBe(
      "https://apply.workable.com/j/7C893E46E3/apply",
    );
  });

  it("leaves a BambooHR posting alone — the form is on the posting page", () => {
    expect(applyUrlFor("https://centric.bamboohr.com/careers/137", "Centric")).toBe(
      "https://centric.bamboohr.com/careers/137",
    );
  });

  // A company's own careers page, an aggregator, a white-labelled Recruitee
  // domain. Guessing "+/apply" on an unknown host produces a link that looks
  // authoritative and 404s, which is the failure worth refusing.
  it("returns null rather than guessing on an unrecognised host", () => {
    expect(applyUrlFor("https://werkenbijdalsem.nl/o/software-engineer", "dalsem")).toBeNull();
    expect(applyUrlFor("https://careers.databricks.com/jobs/123", "databricks")).toBeNull();
  });

  // Runs across every row a brief renders; one malformed URL must not cost the
  // rest their button.
  it("is total — never throws on junk input", () => {
    expect(applyUrlFor("", "")).toBeNull();
    expect(applyUrlFor("not a url", "")).toBeNull();
    expect(applyUrlFor("https://", "")).toBeNull();
    expect(applyUrlFor(undefined as unknown as string, "")).toBeNull();
  });

  // Databricks fronts Greenhouse on its own domain via `?gh_jid=` — the board
  // token is not in the path, so there is nothing to build an apply URL from.
  // Falling back to the posting URL is the caller's job, not this function's.
  it("returns null for a Greenhouse posting behind a custom domain", () => {
    expect(
      applyUrlFor("https://databricks.com/company/careers/open-positions/job?gh_jid=8629999002", "databricks"),
    ).toBeNull();
  });

  it("does not double-append when the apply path is already there", () => {
    expect(applyUrlFor("https://jobs.lever.co/acme/abc-123/apply", "acme")).toBe(
      "https://jobs.lever.co/acme/abc-123/apply",
    );
    expect(applyUrlFor("https://job-boards.greenhouse.io/acme/jobs/1#app", "acme")).toBe(
      "https://job-boards.greenhouse.io/acme/jobs/1#app",
    );
  });
});

/**
 * The shared cases. The Mac apply client opens the URL its own Python
 * `apply_url_for` computes (mac-client/mac_client/adapters.py), while `/draft`
 * hands out the one `getApplyUrl` computes. Two implementations of one rule
 * table is how they end up disagreeing about where the form is, so both suites
 * read the SAME file: mac-client/tests/fixtures/apply-url-cases.json. A rule
 * changed on one side alone fails the other side's test.
 */
const SHARED_CASES_PATH = new URL("../../../mac-client/tests/fixtures/apply-url-cases.json", import.meta.url);

interface SharedApplyUrlCase {
  readonly platform: string | null;
  readonly name: string;
  readonly posting_url: string;
  readonly apply_url: string | null;
}

const shared = JSON.parse(readFileSync(SHARED_CASES_PATH, "utf8")) as {
  readonly cases: readonly SharedApplyUrlCase[];
};

describe("apply URLs shared with the Mac client (mac-client/tests/fixtures/apply-url-cases.json)", () => {
  for (const c of shared.cases) {
    it(`${c.platform ?? "unrecognised"}: ${c.name}`, () => {
      expect(applyUrlFor(c.posting_url, "")).toBe(c.apply_url);
    });
  }

  // A platform added to the adapter registry without a case here would be
  // covered on the TypeScript side only, and the Mac client would silently keep
  // opening its posting page.
  it("has at least one case for every platform in the adapter registry", () => {
    const covered = new Set(shared.cases.map((c) => c.platform));
    const missing = Object.keys(ADAPTERS).filter((ats) => !covered.has(ats));
    expect(missing).toEqual([]);
  });

  it("names a platform for every case that yields a form URL", () => {
    const unlabelled = shared.cases.filter((c) => c.apply_url !== null && c.platform === null);
    expect(unlabelled.map((c) => c.name)).toEqual([]);
  });
});
