/**
 * Unit tests — A2: the queue read is bounded loudly, never silently.
 *
 * THE DEFECT, measured on prod 2026-09-08. `listActionableApplications`
 * defaults to `.limit(100)` and `buildDailyBrief` passed no limit at all.
 * Pushkar had 166 rows qualifying inside his 24h window; the brief loaded the
 * newest 100, ranked 100, pinned 100 ranks, and said nothing about the other
 * 66. They were not merely unprinted — an unpinned row has no `brief_rank`, so
 * `/draft` cannot address it and `mac-client/sync.py` cannot see it either.
 * Sixty-six fresh roles were structurally unreachable and the message they were
 * missing from ended with the words "Nothing is cut — read to the end".
 *
 * This is the same class of defect brief-reach.test.ts documents one layer down
 * (the DISPLAY cap deciding reach). The fix is the same shape: raise the bound
 * past any realistic day, and whenever it still bites, say so with both numbers.
 */

import { describe, it, expect } from "vitest";
import {
  formatDailyBrief,
  type BriefInput,
  type BriefRow,
} from "../../../src/tools/jobhunt/brief.js";
import { BRIEF_QUEUE_LIMIT } from "../../../src/tools/jobhunt/daily-brief.js";
import { scopeMayBeIncomplete } from "../../../src/tools/jobhunt/brief-queue.js";

function row(id: string): BriefRow {
  return {
    id,
    company: `Company ${id}`,
    title: "Backend Engineer",
    track: "backend",
    verdict: "pass",
    route: "hsm",
    country: "NL",
    location: "Amsterdam",
    url: `https://example.com/${id}`,
    overlap: { matched: ["TypeScript"], missing: [], asked: 1, ratio: 1 },
    liveness: "live",
    gates: [{ gate: "Sponsor", status: "pass", evidence: "Exact register match." }],
    legacyGates: false,
    ageDays: 0,
    postedDays: 0,
  };
}

function input(overrides: Partial<BriefInput> = {}): BriefInput {
  return {
    date: new Date("2026-09-08T06:00:00Z"),
    screened: 0,
    perTrack: {},
    rows: [],
    trends: [],
    failures: [],
    ...overrides,
  };
}

describe("A2 — the load limit is wide enough for a real day", () => {
  it("is far above the 166 rows that were being cut at 100", () => {
    expect(BRIEF_QUEUE_LIMIT).toBeGreaterThanOrEqual(500);
  });
});

describe("A2 — a cut is stated with both numbers", () => {
  it("says nothing when every qualifying row was loaded", () => {
    const rows = Array.from({ length: 166 }, (_, i) => row(`r${i}`));
    const rendered = formatDailyBrief(input({ rows, queued: 166 }));
    expect(rendered).not.toContain("Showing the");
    expect(rendered).toContain("166 roles in your queue");
  });

  it("names the loaded count AND the true total when it bites", () => {
    const rows = Array.from({ length: 500 }, (_, i) => row(`r${i}`));
    const rendered = formatDailyBrief(input({ rows, queued: 640 }));
    expect(rendered).toContain("Showing the newest 500 of 640");
  });

  it("stops promising nothing was cut on the run where something was", () => {
    // The contradiction is the defect. A message may cut rows or it may claim
    // completeness; printing both is worse than either, because the founder
    // believes the claim and stops looking for the rows.
    const rows = Array.from({ length: 500 }, (_, i) => row(`r${i}`));
    const cut = formatDailyBrief(input({ rows, queued: 640 }));
    expect(cut).not.toContain("Nothing is cut");

    const whole = formatDailyBrief(input({ rows, queued: 500 }));
    expect(whole).toContain("Nothing is cut");
  });

  it("points the founder at the file that does hold every row", () => {
    const rows = Array.from({ length: 500 }, (_, i) => row(`r${i}`));
    expect(formatDailyBrief(input({ rows, queued: 640 }))).toContain("/csv");
  });

  it("falls back to the loaded count when the total was not measured", () => {
    // `queued` is omitted whenever the count query failed — the same fail-open
    // shape as `agedOut`. An unmeasured total must not render as a cut.
    const rows = Array.from({ length: 12 }, (_, i) => row(`r${i}`));
    const rendered = formatDailyBrief(input({ rows }));
    expect(rendered).toContain("12 roles in your queue");
    expect(rendered).not.toContain("Showing the");
  });
});

describe("A2 — a narrow verb cannot silently see past the read's horizon", () => {
  const NOW = new Date("2026-09-08T12:00:00Z");
  function loaded(daysBack: number[]) {
    return daysBack.map((d) => ({ created_at: new Date(NOW.getTime() - d * 86_400_000) }));
  }

  it("says nothing when the read returned everything", () => {
    // 300 of 300: no horizon exists, so no scope can fall past it.
    expect(scopeMayBeIncomplete(loaded([0, 5, 30]), 3, { windowHours: 24 }, NOW)).toBe(false);
  });

  it("says nothing when the scope is newer than the oldest row loaded", () => {
    // PROD, 2026-09-08: 1,676 rows, 500 read, and the oldest 24h-fresh row sat
    // at position 339 — so `/today` is complete today even though the read is
    // truncated. It must not cry wolf about that.
    expect(scopeMayBeIncomplete(loaded([0, 1, 3]), 1676, { windowHours: 24 }, NOW)).toBe(false);
  });

  it("warns when the scope reaches back past the oldest row loaded", () => {
    // The read stopped 3 days back; a 7-day window is asking about days 3–7
    // that were never loaded. Under a scope the header prints no cut notice,
    // so without this the loss is completely silent.
    expect(scopeMayBeIncomplete(loaded([0, 1, 3]), 1676, { windowHours: 168 }, NOW)).toBe(true);
  });

  it("warns on an absolute cutoff older than the horizon, the way /fresh asks", () => {
    const since = new Date(NOW.getTime() - 10 * 86_400_000);
    expect(scopeMayBeIncomplete(loaded([0, 2]), 1676, { since }, NOW)).toBe(true);
  });

  it("stays silent for an unbounded scope — the header states that cut itself", () => {
    expect(scopeMayBeIncomplete(loaded([0, 90]), 1676, { windowHours: null }, NOW)).toBe(false);
  });
});
