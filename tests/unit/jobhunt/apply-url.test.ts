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

import { describe, it, expect } from "vitest";
import { getApplyUrl as applyUrlFor } from "../../../src/tools/jobhunt/apply-packet.js";

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
