/**
 * Unit tests — two markets in one brief, and the batch waste that funded them.
 *
 * The campaign runs in the Netherlands AND India since 2026-08-01 ("we need
 * dutch and indian both"). Three properties have to hold for that to be worth
 * anything, and each of them is a defect this codebase has already shipped once:
 *
 *  1. THE MARKETS ARE JUDGED BY THEIR OWN NUMBERS. An Indian role gets the rupee
 *     line, never the IND salary criterion; a Dutch one never gets the rupee
 *     line. A euro yardstick against a rupee figure does not produce a slightly
 *     wrong verdict, it produces a confident wrong one.
 *  2. NEITHER MARKET CAN CROWD THE OTHER OUT. An Indian role clears more gates
 *     by construction — no sponsor, no permit floor, no Dutch bar — so on a
 *     merged list it outranks every Dutch role every day.
 *  3. THE NUMBERING SURVIVES THE SPLIT. `/draft 4` has to reach the row printed
 *     as 4, across two blocks, and the same array must be what gets persisted.
 */

import { describe, it, expect } from "vitest";
import {
  allocateByMarket,
  marketOf,
  renderMarketBlocks,
  renderFilterNotes,
  PER_MARKET_DO_TODAY,
} from "../../../src/tools/jobhunt/brief-sections.js";
import { dedupePostings } from "../../../src/tools/jobhunt/ingest.js";
import { selectDoToday, type BriefRow } from "../../../src/tools/jobhunt/brief.js";
import type { PostingCountry } from "../../../src/tools/jobhunt/country.js";
import type { RawPosting } from "../../../src/tools/jobhunt/ats-source.js";

function row(id: string, country: PostingCountry, over: Partial<BriefRow> = {}): BriefRow {
  return {
    id,
    company: `Company ${id}`,
    title: "AI Engineer",
    track: "ai",
    verdict: "pass",
    route: country === "IN" ? "india-local" : "hsm",
    country,
    location: null,
    url: null,
    overlap: { matched: ["TypeScript"], missing: [], asked: 1, ratio: 1 },
    liveness: "live",
    gates: [{ gate: "Experience", status: "pass", evidence: "Asks for 3 years." }],
    legacyGates: false,
    ageDays: 0,
    ...over,
  };
}

function posting(company: string, title: string): RawPosting {
  return {
    company,
    title,
    url: "https://example.com/1",
    description: "x".repeat(500),
    location: "Amsterdam, Netherlands",
    postedAt: null,
  };
}

describe("marketOf — the residual is not quietly Dutch", () => {
  it("places the two markets", () => {
    expect(marketOf("NL")).toBe("netherlands");
    expect(marketOf("IN")).toBe("india");
  });

  it("keeps an unknown or third-country row OUT of both", () => {
    // Folding these into the Netherlands block would assert a market nobody
    // confirmed — the exact move that put a Bogotá role into APPLY TODAY.
    expect(marketOf("unknown")).toBe("unplaced");
    expect(marketOf("other")).toBe("unplaced");
  });
});

describe("allocateByMarket — neither market crowds the other out", () => {
  it("reserves slots for India even when the Dutch list is long", () => {
    const rows = [
      ...Array.from({ length: 6 }, (_, i) => row(`nl${i}`, "NL")),
      row("in1", "IN"),
      row("in2", "IN"),
    ];

    const picked = allocateByMarket(rows, PER_MARKET_DO_TODAY, 6);

    // Without the reservation the six Dutch rows take every slot and India never
    // appears — and a market that never appears is indistinguishable from one
    // with nothing in it.
    // Both Indian rows survive; the Netherlands takes its reserved 3 plus the
    // one slot India could not fill. Six shown, neither market erased.
    expect(picked.filter((r) => r.country === "IN")).toHaveLength(2);
    expect(picked.filter((r) => r.country === "NL")).toHaveLength(4);
    expect(picked).toHaveLength(6);
  });

  it("spills unused reservations rather than wasting the slots", () => {
    const rows = Array.from({ length: 6 }, (_, i) => row(`nl${i}`, "NL"));

    // No Indian rows exist, so the brief must not print a short list to honour a
    // reservation nothing claimed.
    expect(allocateByMarket(rows, PER_MARKET_DO_TODAY, 6)).toHaveLength(6);
  });

  it("puts the Netherlands first — the founder's ordering", () => {
    const picked = allocateByMarket([row("in1", "IN"), row("nl1", "NL")], 3, 6);
    expect(picked[0]!.country).toBe("NL");
  });

  it("never exceeds the total cap", () => {
    const rows = [
      ...Array.from({ length: 5 }, (_, i) => row(`nl${i}`, "NL")),
      ...Array.from({ length: 5 }, (_, i) => row(`in${i}`, "IN")),
    ];
    expect(allocateByMarket(rows, 3, 6)).toHaveLength(6);
  });
});

describe("renderMarketBlocks — the numbering survives the split", () => {
  const selected = [row("nl1", "NL"), row("nl2", "NL"), row("in1", "IN"), row("in2", "IN")];

  it("numbers rows by their position in the SELECTED array, across blocks", () => {
    const rendered = renderMarketBlocks(selected, "/draft", "do_today");

    // The Indian block starts at 3 because two Dutch rows precede it. If it
    // restarted at 1, `/draft 1` would be ambiguous and `/draft 3` would resolve
    // to a row the founder never saw at that number.
    expect(rendered).toContain("/draft 1");
    expect(rendered).toContain("/draft 2");
    expect(rendered).toContain("/draft 3");
    expect(rendered).toContain("/draft 4");
    expect(rendered).not.toContain("/draft 5");
  });

  it("gives each market its own heading", () => {
    const rendered = renderMarketBlocks(selected, "/draft", "do_today");
    expect(rendered).toContain("NETHERLANDS");
    expect(rendered).toContain("INDIA");
    expect(rendered.indexOf("NETHERLANDS")).toBeLessThan(rendered.indexOf("INDIA"));
  });

  it("prints no heading for a market with no rows", () => {
    const rendered = renderMarketBlocks([row("nl1", "NL")], "/draft", "do_today");
    expect(rendered).not.toContain("INDIA");
    expect(rendered).not.toContain("LOCATION NOT CONFIRMED");
  });

  it("agrees with selectDoToday, which is what gets persisted", () => {
    // The single most important property here. `persistBriefRanks` writes the
    // index of each row in `selectDoToday(rows)`, and the message prints the
    // index of each row in the same array. Two functions deriving the order
    // independently would drift silently into drafting for the wrong company.
    const rows = [row("in1", "IN"), row("nl1", "NL"), row("nl2", "NL")];
    const selection = selectDoToday(rows);
    const rendered = renderMarketBlocks(selection, "/draft", "do_today");

    selection.forEach((r, i) => {
      const heading = `${i + 1}. ${r.company}`;
      expect(rendered).toContain(heading);
    });
  });
});

describe("renderFilterNotes — a working day must not read as a broken one", () => {
  it("says nothing when nothing was filtered", () => {
    expect(renderFilterNotes([])).toBe("");
  });

  it("reports filtered rows WITHOUT calling the run incomplete", () => {
    const rendered = renderFilterNotes(["Indeed NL: 8 listing(s) skipped — already closed."]);
    expect(rendered).toContain("8 listing");
    expect(rendered).not.toContain("INCOMPLETE");
    expect(rendered).not.toContain("failed");
  });
});

describe("dedupePostings — the feed repeats itself and we paid to re-screen it", () => {
  it("collapses the same role returned more than once", () => {
    // Live 2026-08-01: AgileEngine came back five times in one sweep and
    // OnTheGoSystems twice at four apiece. Each copy re-ran the register lookup,
    // the salary parse and the experience gate, then overwrote the row it had
    // just written.
    const { unique, collapsed } = dedupePostings([
      posting("AgileEngine", "AI Engineer"),
      posting("AgileEngine", "AI Engineer"),
      posting("AgileEngine", "AI Engineer"),
      posting("Adyen", "Backend Engineer"),
    ]);

    expect(unique).toHaveLength(2);
    expect(collapsed).toBe(2);
  });

  it("keeps genuinely different roles at the same company", () => {
    const { unique, collapsed } = dedupePostings([
      posting("Adyen", "AI Engineer"),
      posting("Adyen", "Backend Engineer"),
    ]);

    expect(unique).toHaveLength(2);
    expect(collapsed).toBe(0);
  });

  it("uses the SAME identity the database uses", () => {
    // Keyed on `dedupeKey`, so casing and punctuation collapse exactly as they
    // do in the unique index. A second notion of identity here would drift from
    // the one that actually prevents double-applying.
    const { collapsed } = dedupePostings([
      posting("Adyen N.V.", "AI Engineer"),
      posting("adyen n.v.", "AI  Engineer"),
    ]);

    expect(collapsed).toBe(1);
  });

  it("reports nothing collapsed for an empty batch", () => {
    expect(dedupePostings([])).toEqual({ unique: [], collapsed: 0 });
  });
});
