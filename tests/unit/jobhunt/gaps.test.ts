/**
 * Unit tests — cv_gaps report.
 *
 * The report tells the founder what to change about his CV, so the expensive
 * failures are quiet ones: claiming a gap in a skill the CV states plainly, and
 * presenting three postings as a market trend. Both are asserted here.
 */

import { describe, it, expect } from "vitest";
import {
  buildGapReport,
  formatGapReport,
  MIN_SAMPLE_FOR_PERCENTAGES,
  UNKNOWN_REPORT_THRESHOLD,
  MIN_CV_TERMS_FOR_GAPS,
  type SignalRow,
} from "../../../src/tools/jobhunt/gaps.js";

const CV = `
Pushkar Verma — AI Engineer.
Built FounderOS: a LangGraph multi-agent kernel in TypeScript with PostgreSQL
checkpointing, Docker deployment, Python tooling, a RAG retrieval layer and a
deterministic eval harness. Comfortable with Node.js and unit testing.
`;

const signal = (term: string, seen: number, category = "infra"): SignalRow => ({
  term,
  category,
  seen_count: seen,
});

describe("buildGapReport", () => {
  it("puts a frequent term absent from the CV in MISSING", () => {
    const report = buildGapReport([signal("Kubernetes", 40)], CV, 100);
    expect(report.missing.map((m) => m.term)).toContain("Kubernetes");
  });

  it("does not report a gap for a skill the CV states", () => {
    // The CV is matched with the SAME extractor as the postings. Matching it
    // differently is how a report claims a gap in a plainly-stated skill.
    const report = buildGapReport(
      [signal("TypeScript", 80, "language"), signal("LangGraph", 60, "ai")],
      CV,
      100,
    );
    expect(report.missing).toHaveLength(0);
    expect(report.confirmed.map((c) => c.term)).toEqual(
      expect.arrayContaining(["TypeScript", "LangGraph"]),
    );
  });

  it("drops terms too rare to be a market signal", () => {
    const report = buildGapReport([signal("Kubernetes", 40), signal("COBOL", 2)], CV, 100);
    const missing = report.missing.map((m) => m.term);
    expect(missing).toContain("Kubernetes");
    expect(missing).not.toContain("COBOL");
  });

  it("reports unknown terms only once they recur", () => {
    const report = buildGapReport(
      [
        signal("ZorroDB", UNKNOWN_REPORT_THRESHOLD, "unknown"),
        signal("BlipQL", UNKNOWN_REPORT_THRESHOLD - 1, "unknown"),
      ],
      CV,
      100,
    );
    expect(report.rising.map((r) => r.term)).toEqual(["ZorroDB"]);
  });

  it("keeps unknown terms out of the MISSING list", () => {
    // An unrecognised token is a candidate for review, not an instruction to
    // put it on a CV.
    const report = buildGapReport([signal("ZorroDB", 90, "unknown")], CV, 100);
    expect(report.missing).toHaveLength(0);
  });

  it("carries the sample size through", () => {
    expect(buildGapReport([], CV, 7).sampleSize).toBe(7);
  });
});

describe("formatGapReport", () => {
  it("refuses to report gaps against a CV too thin to support the claim", () => {
    // Observed 2026-07-29: cv_gaps was fed a 195-char SEARCH EXCERPT instead of
    // the CV and reported 18 skills as missing. Every one of them may have been
    // in the CV — the report was a statement about the CV store, not the market.
    const report = buildGapReport([signal("Kubernetes", 41)], "I am a person.", 100);
    expect(report.cvTermCount).toBeLessThan(MIN_CV_TERMS_FOR_GAPS);
    const out = formatGapReport(report);
    expect(out).toMatch(/cannot report gaps/i);
    expect(out).toMatch(/personal-rag/);
    expect(out).not.toMatch(/MISSING —/);
  });

  it("reports normally once the CV is substantive", () => {
    const report = buildGapReport([signal("Kubernetes", 41)], CV, 100);
    expect(report.cvTermCount).toBeGreaterThanOrEqual(MIN_CV_TERMS_FOR_GAPS);
    expect(formatGapReport(report)).toMatch(/MISSING —/);
  });

  it("refuses to invent a market from zero postings", () => {
    const out = formatGapReport({ sampleSize: 0, missing: [], confirmed: [], rising: [], cvTermCount: 8 });
    expect(out).toMatch(/no data yet/i);
    expect(out).toMatch(/ingest_jobs/);
  });

  it("warns loudly below the acting threshold", () => {
    const report = buildGapReport([signal("Kubernetes", 3)], CV, 3);
    const out = formatGapReport(report);
    expect(out).toMatch(/TOO SMALL TO ACT ON/);
    expect(out).toContain(String(MIN_SAMPLE_FOR_PERCENTAGES));
  });

  it("prints the sample size next to every percentage", () => {
    const out = formatGapReport(buildGapReport([signal("Kubernetes", 41)], CV, 100));
    expect(out).toContain("41% (41/100)");
  });

  it("states plainly that it does not change the CV", () => {
    const out = formatGapReport(buildGapReport([signal("Kubernetes", 41)], CV, 100));
    expect(out).toMatch(/does not change your CV/i);
  });

  it("says so when nothing is missing rather than printing an empty list", () => {
    const out = formatGapReport(buildGapReport([signal("TypeScript", 80, "language")], CV, 100));
    expect(out).toMatch(/nothing frequent in the market is absent/i);
  });
});
