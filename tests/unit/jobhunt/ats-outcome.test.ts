import { describe, expect, it } from "vitest";
import { bandOf, formatTable, groupByBand, outcomeOf } from "../../../src/tools/jobhunt/ats-outcome.js";

const ats = (r?: number) => JSON.stringify({ tailored: true, matchedSkills: [], missingSkills: [], ...(r === undefined ? {} : { initialOverlapRatio: r }) });
const sent = new Date("2026-11-20");

describe("ats outcome report", () => {
  it("bands by percent at the 40/60/80 edges", () => {
    expect([39, 40, 59, 60, 79, 80, 100].map(bandOf)).toEqual(["<40", "40-60", "40-60", "60-80", "60-80", "80+", "80+"]);
    expect(bandOf(undefined)).toBe("unscored");
  });

  it("maps stage to outcome", () => {
    expect(["replied", "interview", "rejected", "applied", "dormant"].map(outcomeOf)).toEqual(["reply", "interview", "reject", "none", "none"]);
  });

  it("counts only sent rows, per band and outcome", () => {
    const t = groupByBand([
      { applied_at: sent, stage: "replied", ats_json: ats(0.62) },
      { applied_at: sent, stage: "applied", ats_json: ats(0.65) },
      { applied_at: sent, stage: "rejected", ats_json: ats(0.2) },
      { applied_at: sent, stage: "applied", ats_json: null },
      { applied_at: null, stage: "drafted", ats_json: ats(0.9) },
    ]);
    expect(t["60-80"]).toEqual({ reply: 1, interview: 0, reject: 0, none: 1 });
    expect(t["<40"].reject).toBe(1);
    expect(t.unscored.none).toBe(1);
    expect(t["80+"]).toEqual({ reply: 0, interview: 0, reject: 0, none: 0 });
    expect(formatTable(t)).toContain("60-80\t1\t0\t0\t1\t2\t50%");
  });
});
