/**
 * Unit tests — the brief hides nothing.
 *
 * Founder direction, 2026-08-01, on the first real production brief:
 *
 *   "I am still unable to get what is the brief in every company written? …
 *    I need each and every info why this is choosen, need everything in bullet
 *    points"
 *   "even if telegram message doesn't gives all the result in one message give
 *    in 2 or 3 messages so that we can read everything and decide for the
 *    outcome"
 *
 * Two properties follow, and they are the ones tested here:
 *   1. Every check on every shown row is printed, with its own result.
 *   2. Length is handled by SPLITTING the message, never by dropping a row —
 *      and when a cap does bite, the brief says so with the number.
 */

import { describe, it, expect } from "vitest";
import {
  DO_TODAY_CAP,
  formatDailyBrief,
  splitForTelegram,
  TELEGRAM_MAX_CHARS,
  type BriefInput,
  type BriefRow,
} from "../../../src/tools/jobhunt/brief.js";

function row(over: Partial<BriefRow> & Pick<BriefRow, "id">): BriefRow {
  return {
    company: `Company ${over.id}`,
    title: "Backend Engineer",
    track: "backend",
    verdict: "pass",
    route: "hsm",
    country: "NL",
    url: "https://example.com/1",
    overlap: { matched: ["TypeScript", "PostgreSQL"], missing: ["Go"], asked: 3, ratio: 0.67 },
    liveness: "live",
    gates: [
      { gate: "Sponsor", status: "pass", evidence: "Exact register match." },
      { gate: "Salary", status: "pass", evidence: "Clears the €52,284 criterion." },
      { gate: "Language", status: "pass", evidence: "No Dutch requirement found." },
      { gate: "Experience", status: "pass", evidence: "Asks for 3 years." },
    ],
    legacyGates: false,
    ageDays: 0,
    ...over,
  };
}

function input(rows: readonly BriefRow[]): BriefInput {
  return {
    date: new Date("2026-08-02T01:30:00Z"),
    screened: rows.length,
    perTrack: { backend: rows.length },
    rows,
    trends: [],
    failures: [],
  };
}

describe("every check reaches the founder", () => {
  it("prints one bullet per check on an actionable row", () => {
    const out = formatDailyBrief(input([row({ id: "1" })]));
    for (const gate of ["Sponsor", "Salary", "Language", "Experience"]) {
      expect(out).toContain(`<b>${gate}:</b>`);
    }
  });

  it("defines the vocabulary it uses, once", () => {
    // "what is this not checked? sponsor? partially overlaps?" — a label nobody
    // defined is not information.
    const out = formatDailyBrief(input([row({ id: "1" })]));
    expect(out).toContain("WHAT THE CHECKS MEAN");
    expect(out).toContain("IND recognised-sponsor register");
    expect(out).toContain("partially overlaps");
  });

  it("only defines the checks that actually appeared today", () => {
    const out = formatDailyBrief(
      input([row({ id: "1", gates: [{ gate: "Sponsor", status: "pass", evidence: "match." }] })]),
    );
    expect(out).toContain("<b>Sponsor</b> —");
    expect(out).not.toContain("<b>Rate</b> —");
  });

  it("spells out the CV comparison instead of printing a bare ratio", () => {
    const out = formatDailyBrief(input([row({ id: "1" })]));
    expect(out).toContain("Your CV vs this ad");
    expect(out).toContain("You already have: TypeScript, PostgreSQL");
    expect(out).toContain("Not on your CV: Go");
  });

  it("says when the ad named nothing measurable, rather than showing 0/0", () => {
    const out = formatDailyBrief(
      input([row({ id: "1", overlap: { matched: [], missing: [], asked: 0, ratio: 0 } })]),
    );
    expect(out).toContain("names no recognisable technology");
  });
});

describe("length is handled by splitting, not by hiding", () => {
  it("shows more than twice the old three rows", () => {
    // The cap was 3. Ten full rows across both actionable sections is roughly
    // four Telegram messages — enough to decide from without becoming a wall of
    // text, which produces the same outcome as hiding the row.
    expect(DO_TODAY_CAP).toBeGreaterThan(3);
  });

  it("splits a long brief into readable parts, each within Telegram's limit", () => {
    const rows = Array.from({ length: DO_TODAY_CAP }, (_, i) => row({ id: String(i + 1) }));
    const parts = splitForTelegram(formatDailyBrief(input(rows)));
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(TELEGRAM_MAX_CHARS);
  });

  it("loses nothing in the split", () => {
    const rows = Array.from({ length: DO_TODAY_CAP }, (_, i) => row({ id: String(i + 1) }));
    const brief = formatDailyBrief(input(rows));
    const rejoined = splitForTelegram(brief).join("\n\n");
    for (const r of rows) expect(rejoined).toContain(r.company);
  });

  it("states the number it could not show when the cap bites", () => {
    // A silent truncation is the failure this pipeline keeps being wrong about.
    const rows = Array.from({ length: DO_TODAY_CAP + 4 }, (_, i) => row({ id: String(i + 1) }));
    const out = formatDailyBrief(input(rows));
    expect(out).toContain("+ 4 more ready to apply to");
  });

  it("tells the founder up front that the brief may arrive in parts", () => {
    const out = formatDailyBrief(input([row({ id: "1" })]));
    expect(out).toContain("spans several messages");
  });
});

describe("the still-open check states its own age", () => {
  it("does not claim a stored 'live' was checked today", () => {
    // The brief once said "we re-checked the posting today" on rows the run had
    // skipped entirely — a claim about a check that had not happened, made on
    // the strength of a value stored days earlier.
    const out = formatDailyBrief(input([row({ id: "1", livenessAgeDays: 4 })]));
    expect(out).toContain("4-day-old check");
    expect(out).not.toContain("this morning");
  });

  it("says so plainly when the check ran in this run", () => {
    const out = formatDailyBrief(input([row({ id: "1", livenessAgeDays: 0 })]));
    expect(out).toContain("this morning's check");
  });

  it("does not invent an age it does not have", () => {
    const out = formatDailyBrief(input([row({ id: "1", livenessAgeDays: null })]));
    expect(out).toContain("when we last checked");
  });
});

describe("a pass that could not be verified is offered, not buried", () => {
  it("routes an unverified pass into ONE QUESTION AWAY rather than dropping it", () => {
    // It is one check from actionable, and that check is "is this still open?".
    // Silently withholding it because a network call failed is the failure
    // direction this pipeline exists to avoid.
    const out = formatDailyBrief(
      input([row({ id: "1", verdict: "pass", liveness: "unverifiable" })]),
    );
    expect(out).toContain("ONE QUESTION AWAY (1)");
    expect(out).toContain("not checked");
  });
});
