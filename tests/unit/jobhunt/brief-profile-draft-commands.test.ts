/**
 * `/jobs tashi` must print `/draft tashi N`, never a bare `/draft N`.
 *
 * A bare `/draft N` resolves against the DEFAULT profile's pinned ranks, so on
 * Tashi's brief it would tailor a CV for whatever company sits at rank N in the
 * founder's queue. Every `/draft` (and `/applied`) the brief prints for a
 * non-default profile — per-row ▸ commands in APPLY TODAY, STRETCH and STILL
 * OPEN, the overflow notes, and the DO THIS NEXT block — has to carry the word
 * `profileSelector()` returns.
 */
import { describe, it, expect } from "vitest";
import { formatDailyBrief, renderNextActions, type BriefInput, type BriefRow } from "../../../src/tools/jobhunt/brief.js";
import { getProfile, profileSelector } from "../../../src/tools/jobhunt/profile-config.js";

function row(overrides: Partial<BriefRow> = {}): BriefRow {
  return {
    id: "id-1",
    company: "Adyen",
    title: "Financial Analyst",
    track: "finance",
    verdict: "pass",
    route: "hsm",
    country: "NL",
    location: "Amsterdam, North Holland, Netherlands",
    url: "https://example.com/1",
    overlap: { matched: ["Excel"], missing: [], asked: 1, ratio: 1 },
    liveness: "live",
    gates: [
      { gate: "Sponsor", status: "pass", evidence: "Exact register match." },
      { gate: "Salary", status: "pass", evidence: "Clears the criterion." },
    ],
    legacyGates: false,
    ageDays: 0,
    ...overrides,
  };
}

function input(overrides: Partial<BriefInput> = {}): BriefInput {
  return {
    date: new Date("2026-10-06T06:00:00Z"),
    perTrack: {},
    rows: [row()],
    trends: [],
    failures: [],
    ...overrides,
  };
}

const tashi = getProfile("wife-nl-finance");
const sel = profileSelector(tashi);

describe("/jobs tashi brief — every /draft names the profile", () => {
  it("profileSelector gives a non-empty word for the non-default profile", () => {
    expect(sel).not.toBe("");
    expect(sel).toBe("tashi");
  });

  it("renderNextActions prints `/draft tashi N` for do-today, stretch and standing rows", () => {
    const out = renderNextActions(
      [row({ id: "a", company: "Alpha" })],
      [row({ id: "s", company: "Stretchy" })],
      [],
      1,
      [row({ id: "o", company: "Oldie" })],
      1,
      sel,
    );
    expect(out).toContain("/draft tashi 1");
    expect(out).toContain("/draft tashi 2");
    expect(out).toContain("/draft tashi 3");
    // The typed fallback under HOW TO APPLY names her too.
    expect(out).toContain("/draft tashi &lt;number&gt;");
    expect(/\/draft \d/.test(out)).toBe(false);
  });

  it("the full brief has no bare /draft N or /applied N anywhere — rows, stretch, standing, overflow, next actions", () => {
    const pass = Array.from({ length: 12 }, (_, i) =>
      row({ id: `p${i}`, company: `Pass${i}`, url: `https://example.com/p${i}` }),
    );
    const stretch = [
      row({
        id: "st",
        company: "Stretchco",
        verdict: "flag",
        gates: [
          { gate: "Sponsor", status: "pass", evidence: "Exact register match." },
          { gate: "Experience", status: "flag", evidence: "Asks for 5+ years." },
        ],
      }),
    ];
    const standing = [row({ id: "old", company: "Oldco", ageDays: 5 })];
    const out = formatDailyBrief(input({ profile: tashi, rows: [...pass, ...stretch], standing }));

    const drafts = out.match(/\/draft [^\s<]+/g) ?? [];
    expect(drafts.length).toBeGreaterThan(0);
    for (const d of drafts) expect(d).toBe("/draft tashi");
    expect(out).not.toMatch(/\/(draft|applied|ask) \d/);
    expect(out).toContain("/draft tashi 1");
    expect(out).toContain("A STRETCH WORTH APPLYING TO");
    expect(out).toContain("STILL OPEN, OLDER THAN TODAY");
  });

  it("the default profile keeps bare commands (a bare command already reaches its queue)", () => {
    const out = formatDailyBrief(input({ profile: getProfile() }));
    expect(out).toContain("/draft 1");
    expect(out).not.toContain("/draft tashi");
  });
});
