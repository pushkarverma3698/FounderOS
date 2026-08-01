/**
 * Regression — an unchecked liveness value must never read as "closed".
 *
 * PROD EVIDENCE (2026-08-01, first real brief after deploy). Every row in
 * `agents.job_applications` carried `liveness = "unknown"` — the column's own
 * default, and a value OUTSIDE the `Liveness` union. `daily-brief.ts` cast it
 * with `row.liveness as Liveness`, so it reached the renderer intact, where a
 * non-exhaustive `else` branch printed:
 *
 *     0/21 skills · ✕ closed · hsm
 *
 * on three roles nobody had checked. Two of them were confirmed open. The brief
 * told the founder a live opportunity was dead, which is the single most
 * expensive direction this pipeline can fail in: a false "closed" removes a role
 * from consideration and emits no signal that it did.
 *
 * The rule these tests hold: only a POSITIVE check may produce a positive or
 * negative claim. Everything else is reported as absence of knowledge.
 */

import { describe, it, expect } from "vitest";
import { toLiveness } from "../../../src/tools/jobhunt/daily-brief.js";
import {
  formatDailyBrief,
  type BriefInput,
  type BriefRow,
} from "../../../src/tools/jobhunt/brief.js";

function row(over: Partial<BriefRow> = {}): BriefRow {
  return {
    id: "r1",
    company: "Shine",
    title: "Software Engineer (All Levels)",
    track: "backend",
    verdict: "flag",
    route: "hsm",
    url: null,
    overlap: { matched: [], missing: [], asked: 21, ratio: 0 },
    liveness: "unverifiable",
    headline: "Sponsor partially overlaps 1 register entry.",
    ageDays: 0,
    ...over,
  };
}

function input(over: Partial<BriefInput> = {}): BriefInput {
  return {
    date: new Date("2026-08-01T01:30:00Z"),
    screened: 7,
    perTrack: { backend: 7 },
    rows: [],
    trends: [],
    failures: [],
    ...over,
  };
}

describe("toLiveness", () => {
  it("passes the three real values through", () => {
    expect(toLiveness("live")).toBe("live");
    expect(toLiveness("expired")).toBe("expired");
    expect(toLiveness("unverifiable")).toBe("unverifiable");
  });

  it("collapses the DB default 'unknown' to unverifiable, not expired", () => {
    // This exact string was on all eight production rows.
    expect(toLiveness("unknown")).toBe("unverifiable");
  });

  it("collapses null, undefined and junk to unverifiable", () => {
    expect(toLiveness(null)).toBe("unverifiable");
    expect(toLiveness(undefined)).toBe("unverifiable");
    expect(toLiveness(42)).toBe("unverifiable");
    expect(toLiveness("LIVE")).toBe("unverifiable");
  });
});

describe("brief never claims a job is closed without a check", () => {
  it("says 'not checked' for an unverifiable row", () => {
    const out = formatDailyBrief(input({ rows: [row({ liveness: "unverifiable" })] }));
    expect(out).toContain("not checked");
    expect(out).not.toContain("✕ closed");
  });

  it("still says closed when the check actually found it closed", () => {
    // The honest negative must survive — this is not about suppressing bad news.
    const out = formatDailyBrief(
      input({ rows: [row({ verdict: "pass", liveness: "expired" })] }),
    );
    expect(out).toContain("CLOSED SINCE WE SAW THEM");
  });

  it("still says still-open when the check confirmed it", () => {
    const out = formatDailyBrief(
      input({ rows: [row({ verdict: "pass", liveness: "live" })] }),
    );
    expect(out).toContain("still open");
    expect(out).not.toContain("not checked");
  });
});
