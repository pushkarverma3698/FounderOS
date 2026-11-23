import { describe, expect, it } from "vitest";
import { factGap, formatFactGap } from "../../../src/tools/jobhunt/fact-sheet-gap.js";

const q = (rowId: string, label: string) => ({ rowId, label });

describe("factGap", () => {
  const gap = factGap([
    q("a", "Will you now or in the future require sponsorship?"),
    q("a", "Desired salary (EUR)"),
    q("b", "Postal code"),
    q("c", "Postal code"),
    q("c", "Why do you want to work here?"),
    q("d", "Years of experience with Python"),
    q("d", "How did you hear about this job?"),
  ]);

  it("counts rows whose every open question is a fact-sheet category", () => {
    expect(gap.rows).toBe(4);
    expect(gap.factOnlyRows).toBe(3);
  });

  it("counts each category once per fact-only row", () => {
    expect(gap.byCategory).toEqual({ work_authorization: 1, salary: 1, postal_code: 1, skill_years: 1, referral_source: 1 });
  });

  it("lists the labels that fit no category", () => {
    expect(gap.otherLabels).toEqual({ "Why do you want to work here?": 1 });
  });

  it("handles no rows and prints a readable block", () => {
    expect(factGap([])).toEqual({ rows: 0, factOnlyRows: 0, byCategory: {}, otherLabels: {} });
    expect(formatFactGap("p1", gap)).toContain("p1: 3 of 4 needs_you rows have only fact-sheet questions open");
  });
});
