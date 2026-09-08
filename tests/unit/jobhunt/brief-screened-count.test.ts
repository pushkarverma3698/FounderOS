/**
 * Unit tests — A3: "screened" means screened, or it is not printed.
 *
 * THE DEFECT. The header's third line read `100 screened · ai 22 · backend 67`,
 * and that 100 was `applications.length` — the size of the apply queue, printed
 * one line above its own freshness line as "100 fresh roles in the queue". The
 * same number, twice, under two different nouns.
 *
 * "Screened" is a machine word with a real referent in this pipeline: the count
 * of postings that survived the funnel far enough for `screenPosting` to run.
 * On the sweep measured 2026-09-08 that number was 1, against 82,751 fetched.
 * Printing the queue size under that word made a claim about the machine that
 * was wrong by five orders of magnitude in one direction and by a factor of one
 * hundred in the other, depending on which reading the founder took.
 *
 * The fix is not a better estimate. It is: print the real one when a caller
 * knows it (the sweep does; a typed `/jobs` does not), and print nothing at all
 * when nobody does. A number that has to be defended is worse than a blank.
 */

import { describe, it, expect } from "vitest";
import {
  formatDailyBrief,
  type BriefInput,
  type BriefRow,
} from "../../../src/tools/jobhunt/brief.js";

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
    perTrack: { ai: 22, backend: 67 },
    rows: [row("a"), row("b")],
    trends: [],
    failures: [],
    ...overrides,
  };
}

describe("A3 — the queue size is called the queue size", () => {
  it("names the queue in the founder's words", () => {
    const rendered = formatDailyBrief(input({ rows: [row("a"), row("b")] }));
    expect(rendered).toContain("2 roles in your queue");
  });

  it("no longer prints the queue size under the word 'screened'", () => {
    const rows = Array.from({ length: 100 }, (_, i) => row(`r${i}`));
    const rendered = formatDailyBrief(input({ rows }));
    expect(rendered).not.toContain("100 screened");
  });

  it("still prints the per-track split — that number was never wrong", () => {
    const rendered = formatDailyBrief(input());
    expect(rendered).toContain("ai 22");
    expect(rendered).toContain("backend 67");
  });
});

describe("A3 — the screening count is printed only when a caller measured it", () => {
  it("states it, with its unit, when the sweep supplied one", () => {
    const rendered = formatDailyBrief(input({ screened: 83_132 }));
    expect(rendered).toContain("83,132");
    expect(rendered).toMatch(/83,132 postings? reached screening/);
  });

  it("prints nothing rather than guessing when no caller supplied one", () => {
    const rendered = formatDailyBrief(input());
    expect(rendered).not.toContain("reached screening");
  });

  it("prints a genuine zero — an empty sweep is a finding, not an absence", () => {
    // 0 and undefined are different states and only one of them is silent.
    // A sweep that fetched 82,751 postings and screened none of them is the
    // exact shape of the 2026-09-06 thirty-hour outage.
    const rendered = formatDailyBrief(input({ screened: 0 }));
    expect(rendered).toMatch(/0 postings reached screening/);
  });
});
