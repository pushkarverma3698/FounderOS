/**
 * Unit tests — re-checking apply links before a file goes out.
 *
 * THE FAILURE THIS GUARDS AGAINST. Every CSV path read the stored `liveness`
 * column and rendered it, having never checked anything. Measured on prod
 * 2026-09-09: 894 of 1,814 rows carried `unknown`, so the file the founder
 * applies from told him "not checked" on half its rows while presenting itself
 * as complete.
 *
 * The rules that matter here are the honesty ones, not the plumbing ones: a
 * budget that silently truncates is the same defect one layer down, and a
 * verification outage must cost the founder the CHECK, never the FILE.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { JobApplication } from "../../../src/db/schema.js";

const verifyLiveness = vi.fn();
const recordLiveness = vi.fn();

vi.mock("../../../src/tools/jobhunt/liveness.js", () => ({
  verifyLiveness: (...args: unknown[]) => verifyLiveness(...args),
}));
vi.mock("../../../src/db/job-queries.js", () => ({
  recordLiveness: (...args: unknown[]) => recordLiveness(...args),
}));

const { refreshLiveness, needsRecheck } = await import(
  "../../../src/tools/jobhunt/liveness-refresh.js"
);

const NOW = new Date("2026-09-09T12:00:00Z");

function row(overrides: Partial<JobApplication> = {}): JobApplication {
  return {
    id: "row-1",
    company: "Aquablu B.V.",
    title: "Finance Analyst",
    url: "https://boards.greenhouse.io/aquablu/jobs/1",
    source: "greenhouse",
    external_id: null,
    liveness: "unknown",
    liveness_checked_at: null,
    posted_at: new Date("2026-09-09T06:00:00Z"),
    ...overrides,
  } as unknown as JobApplication;
}

beforeEach(() => {
  verifyLiveness.mockReset();
  recordLiveness.mockReset();
  recordLiveness.mockResolvedValue(null);
});

describe("needsRecheck", () => {
  it("treats 'unknown' as needing a check whatever the timestamp says", () => {
    // A row can carry a timestamp and still have never been decided; the
    // verdict, not the clock, is what makes it unknown.
    const stamped = row({ liveness: "unknown", liveness_checked_at: NOW });
    expect(needsRecheck(stamped, NOW, 24)).toBe(true);
  });

  it("keeps a verdict checked inside the window", () => {
    const recent = row({
      liveness: "live",
      liveness_checked_at: new Date("2026-09-09T06:00:00Z"),
    });
    expect(needsRecheck(recent, NOW, 24)).toBe(false);
  });

  it("re-checks a verdict older than the window", () => {
    const old = row({
      liveness: "live",
      liveness_checked_at: new Date("2026-09-07T06:00:00Z"),
    });
    expect(needsRecheck(old, NOW, 24)).toBe(true);
  });
});

describe("refreshLiveness", () => {
  it("checks nothing and reports it when every row is already current", async () => {
    const rows = [row({ liveness: "live", liveness_checked_at: NOW })];

    const outcome = await refreshLiveness(rows, { now: NOW });

    expect(verifyLiveness).not.toHaveBeenCalled();
    expect(outcome.alreadyFresh).toBe(1);
    expect(outcome.verified).toBe(0);
  });

  it("spends the budget on the freshest postings first", async () => {
    // The budget belongs where "is it still open" changes an answer. A role
    // published five weeks ago is not that place.
    const rows = [
      row({ id: "old", posted_at: new Date("2026-08-01T00:00:00Z") }),
      row({ id: "new", posted_at: new Date("2026-09-09T09:00:00Z") }),
      row({ id: "mid", posted_at: new Date("2026-09-05T00:00:00Z") }),
    ];
    verifyLiveness.mockResolvedValue([{ id: "new", liveness: "live", reason: "200" }]);

    const outcome = await refreshLiveness(rows, { now: NOW, budget: 1 });

    const targets = verifyLiveness.mock.calls[0]![0] as { id: string }[];
    expect(targets.map((t) => t.id)).toEqual(["new"]);
    expect(outcome.verified).toBe(1);
    expect(outcome.skipped).toBe(2);
  });

  it("reports the rows it could not reach rather than implying a complete file", async () => {
    const rows = [row({ id: "a" }), row({ id: "b" }), row({ id: "c" })];
    verifyLiveness.mockResolvedValue([{ id: "a", liveness: "live", reason: "200" }]);

    const outcome = await refreshLiveness(rows, { now: NOW, budget: 1 });

    expect(outcome.skipped).toBe(2);
  });

  it("returns new objects and never mutates the caller's rows", async () => {
    const original = row({ id: "a" });
    verifyLiveness.mockResolvedValue([{ id: "a", liveness: "expired", reason: "404" }]);

    const outcome = await refreshLiveness([original], { now: NOW });

    expect(original.liveness).toBe("unknown");
    expect(outcome.rows[0]!.liveness).toBe("expired");
    expect(outcome.rows[0]).not.toBe(original);
  });

  it("still returns the rows when verification throws", async () => {
    // A verification outage must cost the check, never the file.
    const rows = [row({ id: "a" })];
    verifyLiveness.mockRejectedValue(new Error("ATS host unreachable"));

    const outcome = await refreshLiveness(rows, { now: NOW });

    expect(outcome.rows).toEqual(rows);
    expect(outcome.verified).toBe(0);
    expect(outcome.skipped).toBe(1);
  });

  it("still returns the rows when the liveness write fails", async () => {
    const rows = [row({ id: "a" })];
    verifyLiveness.mockResolvedValue([{ id: "a", liveness: "live", reason: "200" }]);
    recordLiveness.mockRejectedValue(new Error("db down"));

    const outcome = await refreshLiveness(rows, { now: NOW });

    expect(outcome.rows[0]!.liveness).toBe("live");
    expect(outcome.verified).toBe(1);
  });

  it("persists every verdict it obtained", async () => {
    const rows = [row({ id: "a" }), row({ id: "b" })];
    verifyLiveness.mockResolvedValue([
      { id: "a", liveness: "live", reason: "200" },
      { id: "b", liveness: "expired", reason: "404" },
    ]);

    await refreshLiveness(rows, { now: NOW });

    expect(recordLiveness).toHaveBeenCalledTimes(2);
    expect(recordLiveness).toHaveBeenCalledWith("b", "expired", expect.objectContaining({ reason: "404" }));
  });
});
