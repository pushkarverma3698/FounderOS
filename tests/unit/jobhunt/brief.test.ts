/**
 * Unit tests — the daily brief (pure rendering).
 *
 * The brief is the outcome. Everything upstream is machinery, and the machinery
 * was already working on 2026-07-31 when the pipeline had screened flawlessly
 * for weeks and produced zero applications.
 *
 * So the properties tested here are the ones that make it a DECISION:
 *   · nothing unverified reaches DO TODAY
 *   · nothing disappears without the brief saying so
 *   · an outage never renders as an empty market
 *   · ignoring it is loud
 */

import { describe, it, expect } from "vitest";
import {
  DO_TODAY_CAP,
  formatDailyBrief,
  selectAskable,
  selectDoToday,
  STALE_UNDRAFTED_DAYS,
  type BriefInput,
  type BriefRow,
} from "../../../src/tools/jobhunt/brief.js";

function row(overrides: Partial<BriefRow> = {}): BriefRow {
  return {
    id: "id-1",
    company: "Adyen",
    title: "AI Engineer",
    track: "ai",
    verdict: "pass",
    route: "hsm",
    url: "https://example.com/1",
    overlap: { matched: ["TypeScript"], missing: [], asked: 1, ratio: 1 },
    liveness: "live",
    headline: "Sponsor: exact register match",
    ageDays: 0,
    ...overrides,
  };
}

function input(overrides: Partial<BriefInput> = {}): BriefInput {
  return {
    date: new Date("2026-08-01T06:00:00Z"),
    screened: 34,
    perTrack: { ai: 12, backend: 14, frontend: 8 },
    rows: [row()],
    trends: [],
    failures: [],
    ...overrides,
  };
}

describe("selectDoToday", () => {
  it("admits only rows that passed AND verified live", () => {
    const rows = [
      row({ id: "a", verdict: "pass", liveness: "live" }),
      row({ id: "b", verdict: "flag", liveness: "live" }),
      row({ id: "c", verdict: "pass", liveness: "expired" }),
      row({ id: "d", verdict: "pass", liveness: "unverifiable" }),
    ];
    expect(selectDoToday(rows).map((r) => r.id)).toEqual(["a"]);
  });

  it("caps the list at what a person can act on before work", () => {
    const rows = Array.from({ length: 10 }, (_, i) => row({ id: `r${i}` }));
    expect(selectDoToday(rows)).toHaveLength(DO_TODAY_CAP);
  });
});

describe("selectAskable", () => {
  it("takes flagged rows but never expired ones", () => {
    const rows = [
      row({ id: "a", verdict: "flag", liveness: "unverifiable" }),
      row({ id: "b", verdict: "flag", liveness: "expired" }),
    ];
    expect(selectAskable(rows).map((r) => r.id)).toEqual(["a"]);
  });
});

describe("formatDailyBrief", () => {
  it("leads with the screened count and the per-track split", () => {
    const out = formatDailyBrief(input());
    expect(out).toContain("34 screened");
    expect(out).toContain("ai 12");
    expect(out).toContain("backend 14");
  });

  it("gives every actionable row exactly one command", () => {
    const out = formatDailyBrief(input());
    expect(out).toContain("/draft 1");
  });

  it("prints overlap as a count over a count", () => {
    const out = formatDailyBrief(
      input({
        rows: [row({ overlap: { matched: ["a", "b"], missing: ["c"], asked: 3, ratio: 0.67 } })],
      }),
    );
    expect(out).toContain("2/3");
    expect(out).not.toContain("67%");
  });

  it("names what the posting wants that the CV does not say", () => {
    const out = formatDailyBrief(
      input({
        rows: [row({ overlap: { matched: [], missing: ["Python"], asked: 1, ratio: 0 } })],
      }),
    );
    expect(out).toContain("Python");
    expect(out).toContain("your CV doesn't say");
  });

  it("reports a failed source ABOVE everything and calls the numbers a floor", () => {
    // An outage must read as an outage. A partial run that looks complete is a
    // confident, wrong finding about the Dutch job market.
    const out = formatDailyBrief(input({ failures: ['ATS pool "nl-remote": HTTP 521'] }));
    expect(out).toContain("INCOMPLETE RUN");
    expect(out).toContain("floor, not a measurement");
    expect(out.indexOf("INCOMPLETE RUN")).toBeLessThan(out.indexOf("DO TODAY"));
  });

  it("distinguishes 'nothing actionable' from 'nothing screened'", () => {
    const out = formatDailyBrief(
      input({ screened: 17, rows: [row({ verdict: "reject", liveness: "live" })] }),
    );
    expect(out).toContain("17 screened");
    expect(out).toContain("DO TODAY (0)");
  });

  it("lists closed postings instead of silently dropping them", () => {
    // A row that vanishes unexplained is indistinguishable from a ranking bug.
    const out = formatDailyBrief(
      input({ rows: [row({ company: "Ghost Co", liveness: "expired" })] }),
    );
    expect(out).toContain("CLOSED SINCE WE SAW THEM");
    expect(out).toContain("Ghost Co");
  });

  it("labels an unconfirmed row rather than hiding or trusting it", () => {
    const out = formatDailyBrief(
      input({ rows: [row({ verdict: "flag", liveness: "unverifiable" })] }),
    );
    expect(out).toContain("couldn't confirm still open");
  });

  it("groups rejects by reason with counts", () => {
    const out = formatDailyBrief(
      input({
        rows: [
          row({ id: "a", verdict: "reject", headline: "Dutch required" }),
          row({ id: "b", verdict: "reject", headline: "Dutch required" }),
        ],
      }),
    );
    expect(out).toContain("NOT LAWFUL (2)");
    expect(out).toContain("Dutch required ×2");
  });

  it("nags when PASS roles sit undrafted, and names drafting as the bottleneck", () => {
    // The line that makes ignoring the brief cost something.
    const out = formatDailyBrief(
      input({ rows: [row({ verdict: "pass", ageDays: STALE_UNDRAFTED_DAYS + 2 })] }),
    );
    expect(out).toContain("undrafted");
    expect(out).toContain("Drafting is");
  });

  it("does NOT nag about a role screened today", () => {
    expect(formatDailyBrief(input({ rows: [row({ ageDays: 0 })] }))).not.toContain("undrafted");
  });

  it("reports how long a demanded term has been missing from that track's CV", () => {
    const out = formatDailyBrief(
      input({
        trends: [{ track: "ai", sampleSize: 23, term: "Python", seenCount: 18, absentDays: 14 }],
      }),
    );
    expect(out).toContain("Python — asked 18× across 23 role(s)");
    expect(out).toContain("missing from your ai CV for 14 days");
  });

  it("omits the absence claim when there is no CV to claim absence from", () => {
    const out = formatDailyBrief(
      input({
        trends: [{ track: "ai", sampleSize: 10, term: "Python", seenCount: 8, absentDays: null }],
      }),
    );
    expect(out).toContain("Python — asked 8× across 10 role(s)");
    expect(out).not.toContain("missing from your");
  });

  it("renders deterministically", () => {
    expect(formatDailyBrief(input())).toBe(formatDailyBrief(input()));
  });
});
