/**
 * Unit tests — B5: `/draft 3` means one row, whichever list showed it.
 *
 * THE TRAP, stated by brief-select.ts before these verbs existed: *"A filtered
 * subset would renumber the message and `/draft 3` would tailor for the wrong
 * company."* Until now the display was always a PREFIX of the ordering
 * (`select*` = `order*.slice(0, cap)`), so "the third row on screen" and "the
 * row pinned as 3" were the same row by construction.
 *
 * `/today` and `/fresh` break that construction: they are genuine FILTERS, not
 * prefixes. A row ranked 7 overall can be the first fresh one, and a positional
 * index would print it as 1 while the database still says 7. The founder taps
 * `/draft 1`, and the machine tailors a CV for whatever is actually pinned at 1.
 *
 * So the rank travels ON the row. `briefRankEntries` computes the numbering over
 * the full ranked population — one population for every verb — and the renderer
 * prints `row.rank` rather than its position. The printed number IS the pinned
 * rank, filtered or not.
 *
 * The second half of B5 is the ORDERING, which the founder chose on 2026-09-08:
 * everything on file, freshest first. Without fresh-first, lifting the age limit
 * would fill APPLY TODAY's six slots with whatever matches the CV best across
 * all time — the "442 standing vs 35 fresh" brief he rejected the day before.
 */

import { describe, it, expect } from "vitest";
import { attachBriefRanks, briefRankEntries } from "../../../src/tools/jobhunt/brief-persist.js";
import { renderMarketBlocks } from "../../../src/tools/jobhunt/brief-sections.js";
import { rankRows } from "../../../src/tools/jobhunt/daily-brief.js";
import type { BriefRow } from "../../../src/tools/jobhunt/brief-row.js";
import type { JobApplication } from "../../../src/db/schema.js";

const NOW = new Date("2026-09-08T12:00:00Z");

function row(id: string, over: Partial<BriefRow> = {}): BriefRow {
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
    ...over,
  };
}

describe("B5 — the rank travels on the row", () => {
  it("stamps every row with the number briefRankEntries pinned for it", () => {
    const rows = [row("a"), row("b"), row("c")];
    const ranked = attachBriefRanks(rows, briefRankEntries(rows));
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  it("leaves a row unranked rather than inventing a number for it", () => {
    // A reject is in the brief (founder direction 2026-08-01) and is in no
    // actionable section, so it has no `/draft` number. Undefined is the honest
    // value; a fabricated one would resolve to somebody else's row.
    const rows = [row("a"), row("r", { verdict: "reject" })];
    const ranked = attachBriefRanks(rows, briefRankEntries(rows));
    expect(ranked.find((r) => r.id === "r")?.rank).toBeUndefined();
  });
});

describe("B5 — the renderer prints the pinned rank, not the position", () => {
  it("numbers a full list exactly as before", () => {
    const rows = [row("a", { rank: 1 }), row("b", { rank: 2 }), row("c", { rank: 3 })];
    const out = renderMarketBlocks(rows, "/draft", "do_today");
    expect(out).toContain("1. Company a");
    expect(out).toContain("3. Company c");
  });

  it("keeps a filtered row's own number instead of renumbering from 1", () => {
    // THE WHOLE POINT. `/fresh` shows rows 7 and 12 of the queue; they must
    // print as 7 and 12, because that is what /draft resolves against.
    const out = renderMarketBlocks([row("g", { rank: 7 }), row("l", { rank: 12 })], "/draft", "do_today");
    expect(out).toContain("7. Company g");
    expect(out).toContain("12. Company l");
    expect(out).not.toContain("1. Company g");
    expect(out).toContain("/draft 7");
    expect(out).toContain("/draft 12");
  });

  it("falls back to the position when no rank was attached", () => {
    // Every pre-existing caller and test renders rows with no `rank`, and their
    // display is a prefix of the ordering, so position and rank agree there.
    const out = renderMarketBlocks([row("a"), row("b")], "/draft", "do_today");
    expect(out).toContain("1. Company a");
    expect(out).toContain("2. Company b");
  });
});

describe("B5 — one numbering survives the three verbs", () => {
  it("gives a row the same number in the full list and in every filter of it", () => {
    const all = [row("a"), row("b"), row("c"), row("d")];
    const ranked = attachBriefRanks(all, briefRankEntries(all));
    const target = ranked.find((r) => r.id === "c");

    const jobsView = renderMarketBlocks(ranked, "/draft", "do_today");
    const todayView = renderMarketBlocks(ranked.slice(2), "/draft", "do_today");
    const freshView = renderMarketBlocks([target as BriefRow], "/draft", "do_today");

    for (const view of [jobsView, todayView, freshView]) {
      expect(view).toContain(`/draft ${target?.rank}`);
      expect(view).toContain(`${target?.rank}. Company c`);
    }
  });
});

describe("B5 — freshest first, then best match", () => {
  function application(id: string, postedDaysAgo: number | null, description: string): JobApplication {
    return {
      id,
      company: `Company ${id}`,
      title: "Backend Engineer",
      track: "backend",
      description,
      salary_status: "pass",
      created_at: NOW,
      posted_at: postedDaysAgo === null ? null : new Date(NOW.getTime() - postedDaysAgo * 86_400_000),
    } as unknown as JobApplication;
  }

  const cvs = new Map([["backend", "TypeScript Postgres Kubernetes Terraform Go"]]);

  it("puts today's role above an older one that matches the CV better", () => {
    const ranked = rankRows(
      [
        application("old", 11, "TypeScript Postgres Kubernetes Terraform Go"),
        application("new", 0, "COBOL"),
      ],
      cvs,
      NOW,
    );
    expect(ranked.map((s) => s.row.id)).toEqual(["new", "old"]);
  });

  it("still ranks by CV overlap inside one day", () => {
    const ranked = rankRows(
      [
        application("weak", 0, "COBOL"),
        application("strong", 0, "TypeScript Postgres Kubernetes"),
      ],
      cvs,
      NOW,
    );
    expect(ranked.map((s) => s.row.id)).toEqual(["strong", "weak"]);
  });

  it("measures freshness on posted_at, falling back to created_at", () => {
    // The same coalesce the queue predicate uses. A row the founder pasted
    // himself has no `posted_at` and is as fresh as the minute he found it.
    const ranked = rankRows(
      [application("dated", 5, "TypeScript"), application("undated", null, "TypeScript")],
      cvs,
      NOW,
    );
    expect(ranked.map((s) => s.row.id)).toEqual(["undated", "dated"]);
  });
});
