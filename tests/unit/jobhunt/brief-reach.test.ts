/**
 * Unit tests — the queue the founder can actually reach.
 *
 * MEASURED IN PRODUCTION, 2026-08-24. `agents.job_applications` held 464
 * screened, actionable rows. Three of them were reachable by any command he
 * has:
 *
 *   · `APPLY_QUEUE_MAX_AGE_HOURS` was 24, so the brief only ever read rows
 *     posted in the last day — 3 of 464.
 *   · `persistBriefRanks` pinned a rank only over the CAPPED selection, so even
 *     inside that window `/draft` could address at most DO_TODAY_CAP +
 *     STRETCH_CAP rows. Everything past the cap was printed nowhere and pinned
 *     nowhere, which made it unaddressable rather than merely unprinted.
 *   · `mac-client/mac_client/sync.py` reads `brief_section IN
 *     ('do_today','stretch')`, so an unpinned row is invisible to the apply
 *     client too — not just to Telegram.
 *
 * Fifty-two Dutch recognised-sponsor salary-pass roles were in that table, 11
 * of them confirmed still open, and the last brief pinned three Indian rows.
 * Lifetime applications: 2.
 *
 * So the property these tests hold is: **the display cap bounds what is
 * PRINTED, never what is ADDRESSABLE**, and the printed number still equals the
 * pinned rank — which is the invariant brief-select.ts exists to guarantee and
 * the one a naive fix would break.
 */

import { describe, it, expect } from "vitest";
import {
  DO_TODAY_CAP,
  STRETCH_CAP,
  orderDoToday,
  orderStretch,
  selectDoToday,
  selectStretch,
  type BriefRow,
} from "../../../src/tools/jobhunt/brief.js";
import { briefRankEntries } from "../../../src/tools/jobhunt/brief-persist.js";
import { APPLY_QUEUE_MAX_AGE_HOURS } from "../../../src/db/job-queries.js";

function passRow(id: string, country: BriefRow["country"] = "NL"): BriefRow {
  return {
    id,
    company: `Company ${id}`,
    title: "Backend Engineer",
    track: "backend",
    verdict: "pass",
    route: "hsm",
    country,
    location: "Amsterdam, North Holland, Netherlands",
    url: `https://example.com/${id}`,
    overlap: { matched: ["TypeScript"], missing: [], asked: 1, ratio: 1 },
    liveness: "live",
    gates: [
      { gate: "Sponsor", status: "pass", evidence: "Exact register match." },
      { gate: "Salary", status: "pass", evidence: "Stated €65,000 clears the criterion." },
      { gate: "Language", status: "pass", evidence: "No Dutch requirement found." },
    ],
    legacyGates: false,
    ageDays: 0,
  };
}

/** A row flagged ONLY on the years bar — the stretch band. */
function stretchRow(id: string, country: BriefRow["country"] = "NL"): BriefRow {
  return {
    ...passRow(id, country),
    verdict: "flag",
    gates: [
      { gate: "Sponsor", status: "pass", evidence: "Exact register match." },
      { gate: "Salary", status: "pass", evidence: "Stated €65,000 clears the criterion." },
      { gate: "Experience", status: "flag", evidence: "Asks for 5+ years against ~3.5 shipped." },
    ],
  };
}

describe("the freshness window bounds relevance, not reach", () => {
  it("defaults to 7 days, not 1", () => {
    // 24h left 461 of 464 screened rows outside every command. 168 is the
    // founder's call, 2026-08-24: fresh rows still sort first, and nothing
    // screened is invisible.
    expect(APPLY_QUEUE_MAX_AGE_HOURS).toBe(168);
  });
});

describe("orderDoToday — every qualifying row, uncapped", () => {
  it("returns rows beyond the display cap", () => {
    const rows = Array.from({ length: DO_TODAY_CAP + 9 }, (_, i) => passRow(`p${i + 1}`));
    expect(orderDoToday(rows)).toHaveLength(DO_TODAY_CAP + 9);
  });

  it("selectDoToday is a PREFIX of it, so the printed number is the pinned rank", () => {
    // This is the whole safety argument for capping the display but not the
    // ranking. If the displayed set were a filtered subset rather than a
    // prefix, row "3" on screen would resolve to a different company.
    const rows = Array.from({ length: DO_TODAY_CAP + 9 }, (_, i) => passRow(`p${i + 1}`));
    const ordered = orderDoToday(rows);
    const shown = selectDoToday(rows);

    expect(shown).toHaveLength(DO_TODAY_CAP);
    expect(shown.map((r) => r.id)).toEqual(ordered.slice(0, DO_TODAY_CAP).map((r) => r.id));
  });
});

describe("orderStretch — same property for the stretch band", () => {
  it("returns rows beyond the display cap, and selectStretch is its prefix", () => {
    const rows = Array.from({ length: STRETCH_CAP + 5 }, (_, i) => stretchRow(`s${i + 1}`));
    const ordered = orderStretch(rows);

    expect(ordered).toHaveLength(STRETCH_CAP + 5);
    expect(selectStretch(rows).map((r) => r.id)).toEqual(
      ordered.slice(0, STRETCH_CAP).map((r) => r.id),
    );
  });
});

describe("briefRankEntries — what gets pinned", () => {
  it("pins a rank for every do-today row, not only the printed ones", () => {
    const rows = Array.from({ length: DO_TODAY_CAP + 9 }, (_, i) => passRow(`p${i + 1}`));
    const entries = briefRankEntries(rows).filter((e) => e.section === "do_today");

    expect(entries).toHaveLength(DO_TODAY_CAP + 9);
    expect(entries.map((e) => e.rank)).toEqual(
      Array.from({ length: DO_TODAY_CAP + 9 }, (_, i) => i + 1),
    );
  });

  it("numbers stretch from the FULL do-today length, not the displayed one", () => {
    // The bug a partial fix would ship: pinning all do-today rows but starting
    // stretch at `DO_TODAY_CAP + 1` would collide two rows on the same number,
    // and `ja_brief_rank_uniq` would reject the second — silently losing it.
    const rows = [
      ...Array.from({ length: DO_TODAY_CAP + 9 }, (_, i) => passRow(`p${i + 1}`)),
      ...Array.from({ length: 3 }, (_, i) => stretchRow(`s${i + 1}`)),
    ];
    const entries = briefRankEntries(rows);
    const stretch = entries.filter((e) => e.section === "stretch");

    expect(stretch.map((e) => e.rank)).toEqual([
      DO_TODAY_CAP + 10,
      DO_TODAY_CAP + 11,
      DO_TODAY_CAP + 12,
    ]);
  });

  it("never issues the same rank twice within a section", () => {
    const rows = [
      ...Array.from({ length: 30 }, (_, i) => passRow(`p${i + 1}`, i % 2 === 0 ? "NL" : "IN")),
      ...Array.from({ length: 8 }, (_, i) => stretchRow(`s${i + 1}`, i % 2 === 0 ? "NL" : "IN")),
    ];
    const entries = briefRankEntries(rows);

    for (const section of ["do_today", "stretch", "ask"] as const) {
      const ranks = entries.filter((e) => e.section === section).map((e) => e.rank);
      expect(new Set(ranks).size).toBe(ranks.length);
    }
  });

  it("pins every row exactly once across all sections", () => {
    const rows = [
      ...Array.from({ length: 12 }, (_, i) => passRow(`p${i + 1}`)),
      ...Array.from({ length: 5 }, (_, i) => stretchRow(`s${i + 1}`)),
    ];
    const ids = briefRankEntries(rows).map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
