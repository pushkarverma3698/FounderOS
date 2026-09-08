/**
 * Unit tests — A1: a row states BOTH ages, and never conflates them.
 *
 * THE DEFECT. The meta line read `seen 3d ago`, rendered from `created_at` —
 * when WE stored the row, not when the EMPLOYER published it. Those are
 * different facts and the founder acts on the first one: a posting published
 * thirteen days ago is thirteen days of other applicants ahead of him,
 * regardless of how recently our sweep happened to find the board it sits on.
 * The word "seen" is ours, and the brief printed it where he read "posted".
 *
 * The window itself was never wrong — `applyQueueFreshnessSql` has always
 * filtered on `coalesce(posted_at, created_at)`. Only the RENDERING was, which
 * is the more dangerous half: a wrong filter shows too few rows and is noticed,
 * a wrong label shows the right rows described incorrectly and is believed.
 *
 * So the row now prints both, and says so in words rather than in one number
 * whose meaning has to be remembered.
 */

import { describe, it, expect } from "vitest";
import { renderRow, type BriefRow } from "../../../src/tools/jobhunt/brief-row.js";
import { toBriefRow } from "../../../src/tools/jobhunt/brief-assemble.js";
import type { JobApplication } from "../../../src/db/schema.js";

const NOW = new Date("2026-09-08T12:00:00Z");

function row(overrides: Partial<BriefRow> = {}): BriefRow {
  return {
    id: "id-1",
    company: "Adyen",
    title: "AI Engineer",
    track: "ai",
    verdict: "pass",
    route: "hsm",
    country: "NL",
    location: "Amsterdam",
    url: "https://example.com/1",
    overlap: { matched: ["TypeScript"], missing: [], asked: 1, ratio: 1 },
    liveness: "live",
    gates: [{ gate: "Sponsor", status: "pass", evidence: "Exact register match." }],
    legacyGates: false,
    ageDays: 0,
    postedDays: 0,
    ...overrides,
  };
}

describe("A1 — the row prints publication age and discovery age separately", () => {
  it("states both when the employer gave a date", () => {
    const rendered = renderRow(row({ postedDays: 6, ageDays: 0 }), 1, "/draft", "do_today");
    expect(rendered).toContain("posted 6d ago");
    expect(rendered).toContain("found today");
  });

  it("says 'today' for both when the posting is genuinely fresh", () => {
    const rendered = renderRow(row({ postedDays: 0, ageDays: 0 }), 1, "/draft", "do_today");
    expect(rendered).toContain("posted today · found today");
  });

  it("uses the singular day form rather than '1d'", () => {
    const rendered = renderRow(row({ postedDays: 1, ageDays: 1 }), 1, "/draft", "do_today");
    expect(rendered).toContain("posted 1d ago · found 1d ago");
  });

  it("admits an unknown publication date instead of implying it was today", () => {
    // The single most important case. `posted_at` is NULL whenever the source
    // did not state one — every hand-pasted posting, and every ATS whose feed
    // omits the field. Falling back to `created_at` here would print OUR
    // timestamp under the word "posted", which is the original defect wearing
    // the fix's label.
    const rendered = renderRow(row({ postedDays: null, ageDays: 2 }), 1, "/draft", "do_today");
    expect(rendered).toContain("posted date not stated");
    expect(rendered).toContain("found 2d ago");
    expect(rendered).not.toContain("posted today");
  });

  it("no longer prints the ambiguous 'seen' label", () => {
    const rendered = renderRow(row(), 1, "/draft", "do_today");
    expect(rendered).not.toContain("seen ");
  });
});

describe("A1 — toBriefRow derives the publication age from posted_at only", () => {
  function application(overrides: Partial<JobApplication> = {}): JobApplication {
    return {
      id: "id-1",
      company: "Adyen",
      title: "AI Engineer",
      track: "ai",
      salary_status: "pass",
      route: "hsm",
      country: "NL",
      location: "Amsterdam",
      url: "https://example.com/1",
      liveness: "live",
      gate_json: null,
      salary_evidence: null,
      created_at: NOW,
      posted_at: null,
      liveness_checked_at: null,
      ...overrides,
    } as unknown as JobApplication;
  }

  const overlap = { matched: [], missing: [], asked: 0, ratio: 0 };

  it("reads posted_at when the source stated one", () => {
    const stored = application({
      posted_at: new Date("2026-09-02T12:00:00Z"),
      created_at: new Date("2026-09-08T11:00:00Z"),
    });
    const built = toBriefRow(stored, overlap, NOW, new Map());
    expect(built.postedDays).toBe(6);
    expect(built.ageDays).toBe(0);
  });

  it("returns null — never created_at — when the source stated none", () => {
    const stored = application({ posted_at: null, created_at: new Date("2026-09-06T12:00:00Z") });
    const built = toBriefRow(stored, overlap, NOW, new Map());
    expect(built.postedDays).toBeNull();
    expect(built.ageDays).toBe(2);
  });
});
