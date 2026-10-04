import { describe, expect, it } from "vitest";
import { renderProgress } from "../../../src/tools/jobhunt/brief-progress.js";
import { formatDailyBrief, type BriefInput } from "../../../src/tools/jobhunt/brief.js";

describe("renderProgress", () => {
  it("shows the goal when one is set", () => {
    expect(renderProgress({ applied: 2, goal: 5 })).toBe("<b>📈 This week: 2 applied · goal 5</b>");
  });
  it("omits the goal when none is set", () => {
    expect(renderProgress({ applied: 0, goal: null })).toBe("<b>📈 This week: 0 applied</b>");
  });
});

describe("brief progress line", () => {
  const base = { date: new Date("2026-10-04T08:00:00Z"), perTrack: {}, rows: [], trends: [], failures: [] } as unknown as BriefInput;
  it("replaces the undrafted nag when progress is known", () => {
    const out = formatDailyBrief({ ...base, progress: { applied: 2, goal: 5 } });
    expect(out).toContain("This week: 2 applied · goal 5");
    expect(out).not.toContain("sat undrafted");
  });
});
