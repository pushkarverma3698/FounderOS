/**
 * Unit tests — which rows get the liveness budget.
 *
 * Regression for the 2026-07-31 live run. 22 postings screened, 5 cleared every
 * legal gate, and the brief's DO TODAY section said "0". Liveness verification
 * ran on the top 8 rows by stack overlap, all 8 of which were FLAGs; every PASS
 * finished the run at `unknown` and was therefore ineligible for DO TODAY.
 *
 * A PASS is the only verdict that can become an application. Spending the
 * verification budget on rows that cannot be applied to — and then reporting
 * "nothing to do" — is the pipeline running perfectly and producing nothing.
 */

import { describe, it, expect } from "vitest";
import { verificationTargets } from "../../../src/tools/jobhunt/daily-brief.js";
import { trimToSentence } from "../../../src/tools/jobhunt/brief-row.js";
import type { OverlapResult } from "../../../src/tools/jobhunt/overlap.js";

function overlap(matched: number, asked: number): OverlapResult {
  return {
    matched: Array.from({ length: matched }, (_, i) => `m${i}`),
    missing: Array.from({ length: asked - matched }, (_, i) => `x${i}`),
    asked,
    ratio: asked === 0 ? 0 : matched / asked,
  };
}

function row(id: string, verdict: string, matched: number, asked = 20) {
  return { row: { id, salary_status: verdict } as never, overlap: overlap(matched, asked) };
}

describe("verificationTargets", () => {
  it("verifies a PASS before a higher-overlap FLAG", () => {
    // The exact live failure: flags outranked every pass on overlap and
    // consumed the whole budget.
    const scored = [row("flag-hi", "flag", 18), row("pass-lo", "pass", 2)];
    expect((verificationTargets(scored, 1) as Array<{ row: { id: string } }>).map((s) => s.row.id)).toEqual(["pass-lo"]);
  });

  it("orders passes among themselves by overlap", () => {
    const scored = [row("p-lo", "pass", 3), row("p-hi", "pass", 9)];
    expect((verificationTargets(scored, 2) as Array<{ row: { id: string } }>).map((s) => s.row.id)).toEqual(["p-hi", "p-lo"]);
  });

  it("still verifies flags once every pass has a slot", () => {
    // Flags are not abandoned — a flag the founder resolves becomes an
    // application, so a dead one is still worth knowing about.
    const scored = [row("f1", "flag", 15), row("p1", "pass", 1)];
    expect((verificationTargets(scored, 5) as Array<{ row: { id: string } }>).map((s) => s.row.id)).toEqual(["p1", "f1"]);
  });

  it("never returns more than the budget", () => {
    const scored = Array.from({ length: 40 }, (_, i) => row(`r${i}`, "pass", i));
    expect(verificationTargets(scored, 8)).toHaveLength(8);
  });

  it("returns nothing for an empty pool rather than throwing", () => {
    expect(verificationTargets([], 8)).toEqual([]);
  });

  it("does not spend the budget on rejects", () => {
    // A reject is a legal bar. Whether it is still open changes no decision.
    const scored = [row("rej", "reject", 20), row("p", "pass", 1)];
    expect((verificationTargets(scored, 8) as Array<{ row: { id: string } }>).map((s) => s.row.id)).toEqual(["p"]);
  });
});

describe("trimToSentence", () => {
  it("ends on a sentence boundary instead of mid-word", () => {
    // Live 2026-07-31: the sponsor gate rendered "…permit. They c".
    const long =
      '"Ottimate" is absent from the recognised-sponsor register. ' +
      "They cannot lawfully sponsor a highly skilled migrant permit. " +
      "They could still hire on another basis entirely, which is a separate question.";
    const out = trimToSentence(long, 160);
    expect(out.length).toBeLessThanOrEqual(160);
    expect(out.endsWith(".")).toBe(true);
    expect(out).toContain("cannot lawfully sponsor");
  });

  it("leaves a short line untouched", () => {
    const short = 'Exact register match: "BridgeFund B.V.".';
    expect(trimToSentence(short, 160)).toBe(short);
  });

  it("falls back to a word boundary with an ellipsis when there is no sentence stop", () => {
    const out = trimToSentence("word ".repeat(60), 160);
    expect(out.length).toBeLessThanOrEqual(161);
    expect(out.endsWith("\u2026")).toBe(true);
    expect(out).not.toMatch(/\s\u2026$/);
  });
});

describe("market-trend lines", () => {
  it("never prints an impossible share", async () => {
    // Live 2026-07-31: "Distributed Systems 150%". `seen_count` is an all-time
    // counter incremented on every passing screen, while the denominator counted
    // distinct current rows — two different populations. A percentage over 100
    // is not a rounding artefact, it is a number the data cannot support.
    const { formatDailyBrief } = await import("../../../src/tools/jobhunt/brief.js");
    const out = formatDailyBrief({
      date: new Date("2026-07-31T00:00:00Z"),
      screened: 4,
      perTrack: { backend: 4 },
      rows: [],
      trends: [
        { track: "backend", sampleSize: 4, term: "Distributed Systems", seenCount: 6, absentDays: 2 },
      ],
      failures: [],
    });
    expect(out).not.toMatch(/\b1\d\d%|\b[2-9]\d\d%/);
    expect(out).toContain("Distributed Systems");
    // The raw sighting count is the number we actually have — report that.
    expect(out).toContain("6");
  });
});
