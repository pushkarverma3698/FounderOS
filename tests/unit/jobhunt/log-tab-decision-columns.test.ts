/**
 * Unit tests — the log CSV carries the columns you decide from.
 *
 * THE FAILURE THIS GUARDS AGAINST. Until 2026-09-09 the log tab held eight
 * columns: no rank, no permit basis, no pay, no sponsor verdict, no still-open
 * check. So the ONLY file that reaches past the ranked queue — the one you fall
 * back to when the queue is capped — was also the one you could not act on, and
 * the founder had to know to say the word "queue" to get a usable file.
 *
 * The ordering rule is the subtle one: `brief_rank` is what `/draft N` resolves
 * against, so an unranked row must print an EMPTY `#` rather than a position in
 * this file. A renumbered row is worse than an unnumbered one — it resolves, to
 * the wrong company.
 */

import { describe, it, expect } from "vitest";
import type { JobApplication } from "../../../src/db/schema.js";
import {
  LOG_HEADER,
  QUEUE_HEADER,
  buildLogTab,
  compareByRank,
  logRow,
} from "../../../src/tools/jobhunt/sheet-rows.js";

const NOW = new Date("2026-09-09T12:00:00Z");

function row(overrides: Partial<JobApplication> = {}): JobApplication {
  return {
    id: "row-1",
    tenant_id: "turicks",
    company: "Aquablu B.V.",
    title: "Finance Analyst",
    track: "fpa",
    route: "hsm",
    url: "https://boards.greenhouse.io/aquablu/jobs/1",
    liveness: "live",
    sponsor_verdict: "sponsor",
    salary_status: "pass",
    salary_evidence: null,
    gate_json: JSON.stringify([{ gate: "Sponsor", status: "pass", evidence: "on register" }]),
    brief_section: "do_today",
    brief_rank: 3,
    posted_at: new Date("2026-09-08T12:00:00Z"),
    location: "Amsterdam",
    country: "NL",
    applied_at: null,
    skipped_at: null,
    created_at: new Date("2026-09-09T06:00:00Z"),
    ...overrides,
  } as unknown as JobApplication;
}

describe("LOG_HEADER", () => {
  it("carries every decision column the queue carries", () => {
    // The founder named these four by hand. If the log can be the fallback file,
    // it has to answer the same questions the shortlist answers.
    for (const column of ["#", "Permit basis", "Pay", "Sponsor", "Still open?"]) {
      expect(LOG_HEADER).toContain(column);
    }
  });

  it("keeps the two columns only the audit trail has", () => {
    expect(LOG_HEADER).toContain("Verdict");
    expect(LOG_HEADER).toContain("Applied");
    expect(QUEUE_HEADER).not.toContain("Verdict");
  });

  it("has one cell per header column", () => {
    expect(logRow(row(), NOW)).toHaveLength(LOG_HEADER.length);
  });
});

describe("logRow", () => {
  it("prints the command that resolves the row, not a bare number", () => {
    const cells = logRow(row({ brief_rank: 47, brief_section: "do_today" }), NOW);
    expect(cells[LOG_HEADER.indexOf("#")]).toBe("/draft 47");
  });

  it("prints /ask for an ask row, because 3 names two different roles", () => {
    // Measured on prod 2026-09-09: every rank 1–12 was held by exactly two
    // rows, one `ask` and one `do_today`. DRAFT_SECTIONS excludes `ask`, so
    // both numbers are correct — a bare "3" is what would be wrong.
    const cells = logRow(row({ brief_rank: 3, brief_section: "ask" }), NOW);
    expect(cells[LOG_HEADER.indexOf("#")]).toBe("/ask 3");
  });

  it("leaves # empty for a row the ranking never pinned", () => {
    // An unranked row cannot be drafted by number. Printing "1" beside it would
    // make /draft 1 resolve to a different company.
    const cells = logRow(row({ brief_rank: null }), NOW);
    expect(cells[LOG_HEADER.indexOf("#")]).toBe("");
  });

  it("reads the same sponsor and liveness wording as the queue tab", () => {
    const cells = logRow(row({ sponsor_verdict: "uncertain", liveness: "unverifiable" }), NOW);
    expect(cells[LOG_HEADER.indexOf("Sponsor")]).toBe("unclear — verify before applying");
    expect(cells[LOG_HEADER.indexOf("Still open?")]).toBe("couldn't check");
  });

  it("states the pay evidence rather than a bare verdict when it did not pass", () => {
    const cells = logRow(row({ salary_status: "flag", salary_evidence: "no salary stated" }), NOW);
    expect(cells[LOG_HEADER.indexOf("Pay")]).toBe("no salary stated");
  });

  it("still carries the apply link", () => {
    const cells = logRow(row(), NOW);
    expect(cells[LOG_HEADER.indexOf("Link")]).toBe("https://boards.greenhouse.io/aquablu/jobs/1");
  });
});

describe("compareByRank", () => {
  it("puts ranked rows before unranked ones", () => {
    const ranked = row({ id: "r", brief_rank: 90 });
    const unranked = row({ id: "u", brief_rank: null });
    expect(compareByRank(ranked, unranked)).toBeLessThan(0);
    expect(compareByRank(unranked, ranked)).toBeGreaterThan(0);
  });

  it("orders ranked rows by their pinned number", () => {
    expect(compareByRank(row({ brief_rank: 2 }), row({ brief_rank: 11 }))).toBeLessThan(0);
  });

  it("keeps the two numbering namespaces apart instead of interleaving them", () => {
    // /draft 9 and /ask 1 are different roles. Sorting them into one run of
    // numbers would read as a single sequence with duplicates in it.
    const draftable = row({ brief_rank: 9, brief_section: "do_today" });
    const askable = row({ brief_rank: 1, brief_section: "ask" });
    expect(compareByRank(draftable, askable)).toBeLessThan(0);
  });

  it("falls back to newest-first among unranked rows", () => {
    const newer = row({ brief_rank: null, created_at: new Date("2026-09-09T10:00:00Z") });
    const older = row({ brief_rank: null, created_at: new Date("2026-09-01T10:00:00Z") });
    expect(compareByRank(newer, older)).toBeLessThan(0);
  });
});

describe("buildLogTab", () => {
  it("sorts by pinned rank rather than by screening time", () => {
    // The query orders by screening time, which is right for an audit trail and
    // wrong for a file you apply from.
    const table = buildLogTab(
      [row({ id: "c", brief_rank: null }), row({ id: "a", brief_rank: 9 }), row({ id: "b", brief_rank: 1 })],
      NOW,
    );
    const rankColumn = table.slice(1).map((cells) => cells[LOG_HEADER.indexOf("#")]);
    expect(rankColumn).toEqual(["/draft 1", "/draft 9", ""]);
  });

  it("groups the draftable rows above the ask rows", () => {
    const table = buildLogTab(
      [
        row({ id: "ask1", brief_rank: 1, brief_section: "ask" }),
        row({ id: "do9", brief_rank: 9, brief_section: "do_today" }),
      ],
      NOW,
    );
    const rankColumn = table.slice(1).map((cells) => cells[LOG_HEADER.indexOf("#")]);
    expect(rankColumn).toEqual(["/draft 9", "/ask 1"]);
  });

  it("does not mutate the array it was given", () => {
    const rows = [row({ id: "a", brief_rank: 9 }), row({ id: "b", brief_rank: 1 })];
    buildLogTab(rows, NOW);
    expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("keeps rejects — that is the point of this tab", () => {
    const table = buildLogTab([row({ brief_section: null, salary_status: "reject" })], NOW);
    expect(table).toHaveLength(2);
    expect(table[1]![LOG_HEADER.indexOf("Verdict")]).toBe("not shortlisted");
  });
});
