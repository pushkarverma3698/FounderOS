/**
 * Unit tests — what the job Sheet actually says.
 *
 * THE FAILURE THIS GUARDS AGAINST. The Sheet replaced the Telegram brief, and a
 * spreadsheet cell cannot explain itself the way prose could. Every cell here
 * has to be legible to someone who has never read the code — and, more
 * importantly, must never read as MORE certain than the pipeline actually is.
 * "couldn't check" turning into "closed", or "uncertain" reading as a yes, are
 * the two ways this file could quietly cost the founder a real opportunity or a
 * wasted application.
 */

import { describe, it, expect } from "vitest";
import type { JobApplication } from "../../../src/db/schema.js";
import {
  QUEUE_HEADER,
  buildQueueTab,
  buildLogTab,
  livenessCell,
  postedCell,
  queueRow,
  sponsorCell,
  whyCell,
  yearsCell,
} from "../../../src/tools/jobhunt/sheet-rows.js";

const NOW = new Date("2026-08-06T12:00:00Z");

function row(overrides: Partial<JobApplication> = {}): JobApplication {
  return {
    id: "row-1",
    tenant_id: "turicks",
    company: "Aquablu B.V.",
    title: "Embedded Software Engineer",
    track: "backend",
    url: "https://boards.greenhouse.io/aquablu/jobs/1",
    liveness: "live",
    sponsor_verdict: "sponsor",
    salary_status: "pass",
    salary_evidence: null,
    gate_json: JSON.stringify([{ gate: "Sponsor", status: "pass", evidence: "on register" }]),
    brief_section: "do_today",
    brief_rank: 3,
    posted_at: new Date("2026-08-05T12:00:00Z"),
    location: "Amsterdam",
    country: "NL",
    applied_at: null,
    skipped_at: null,
    created_at: new Date("2026-08-06T06:00:00Z"),
    ...overrides,
  } as unknown as JobApplication;
}

describe("livenessCell", () => {
  it("never lets an unverifiable posting read as a closed one", () => {
    // The asymmetry liveness.ts is built around: calling a live job dead removes
    // a real opportunity and emits no signal that it did.
    expect(livenessCell("unverifiable")).toBe("couldn't check");
    expect(livenessCell("unverifiable")).not.toContain("no");
    expect(livenessCell("expired")).toBe("no — gone");
  });

  it("distinguishes never-checked from checked-and-open", () => {
    expect(livenessCell("unknown")).toBe("not checked");
    expect(livenessCell(null)).toBe("not checked");
    expect(livenessCell("live")).toBe("yes — checked");
  });
});

describe("sponsorCell", () => {
  it("never lets 'uncertain' read as a yes", () => {
    // A false yes on the permit gate costs an application AND teaches the
    // founder to trust a gate that guessed.
    const cell = sponsorCell("uncertain");
    expect(cell).toContain("unclear");
    expect(cell).toContain("verify");
    expect(cell).not.toMatch(/^yes/);
  });

  it("states the register plainly for the other verdicts", () => {
    expect(sponsorCell("sponsor")).toBe("yes — on the IND register");
    expect(sponsorCell("not-sponsor")).toBe("not on the register");
    expect(sponsorCell(null)).toBe("not checked");
  });
});

describe("postedCell", () => {
  it("says the date is unknown rather than implying freshness", () => {
    // An undated posting is of UNKNOWN age; printing "today" would put a
    // three-year-old listing at the top of a queue that promised new roles.
    expect(postedCell(null, NOW)).toBe("date unknown");
  });

  it("reads in days, in plain words", () => {
    expect(postedCell(new Date("2026-08-06T06:00:00Z"), NOW)).toBe("today");
    expect(postedCell(new Date("2026-08-05T06:00:00Z"), NOW)).toBe("yesterday");
    expect(postedCell(new Date("2026-08-01T12:00:00Z"), NOW)).toBe("5 days ago");
  });

  it("does not print a negative age for a posting dated in the future", () => {
    expect(postedCell(new Date("2026-08-08T12:00:00Z"), NOW)).toBe("today");
  });
});

describe("whyCell", () => {
  it("gives a stretch row the stretch reason, not the ask reason", () => {
    // The defect this pins: a stretch row is a `flag` exactly like an ask row,
    // so deriving the sentence from verdict alone told the founder to send the
    // one question that invites a pre-emptive rejection on the years bar.
    const cell = whyCell(row({ brief_section: "stretch" }));
    expect(cell).toContain("years");
    expect(cell).not.toContain("question");
  });

  it("admits when a row predates the per-check record", () => {
    expect(whyCell(row({ gate_json: null, salary_evidence: null }))).toContain("re-screen");
  });

  it("names the blocking gates for an ask row", () => {
    const cell = whyCell(
      row({
        brief_section: "ask",
        gate_json: JSON.stringify([
          { gate: "Sponsor", status: "pass", evidence: "on register" },
          { gate: "Salary", status: "flag", evidence: "not stated" },
        ]),
      }),
    );
    expect(cell).toContain("Salary");
    expect(cell).not.toContain("Sponsor");
  });
});

describe("yearsCell", () => {
  it("reads the figure off the Experience gate's own evidence", () => {
    const cell = yearsCell(
      row({
        gate_json: JSON.stringify([
          { gate: "Experience", status: "flag", evidence: 'asks for "5+ years" minimum' },
        ]),
      }),
    );
    expect(cell).toBe("5+");
  });

  it("is empty rather than wrong when no Experience gate ran", () => {
    expect(yearsCell(row())).toBe("");
  });
});

describe("queueRow", () => {
  it("prints the PINNED brief rank, never the sheet's own position", () => {
    // /draft 3 resolves against brief_rank. If the sheet renumbered its rows,
    // the two would disagree the moment a row left the queue — and the founder
    // would draft for the wrong job.
    const [first] = queueRow(row({ brief_rank: 7 }), NOW);
    expect(first).toBe(7);
  });

  it("has exactly one cell per header column", () => {
    expect(queueRow(row(), NOW)).toHaveLength(QUEUE_HEADER.length);
  });

  it("falls back to the salary evidence when the pay bar was not met", () => {
    const cells = queueRow(row({ salary_status: "flag", salary_evidence: "not stated" }), NOW);
    expect(cells).toContain("not stated");
  });
});

describe("buildQueueTab / buildLogTab", () => {
  it("puts the header first so the sheet is readable from row 1", () => {
    const tab = buildQueueTab([row()], NOW);
    expect(tab[0]).toEqual([...QUEUE_HEADER]);
    expect(tab).toHaveLength(2);
  });

  it("renders a header-only tab when there is nothing queued", () => {
    // An empty queue must still clear the sheet to its header — leaving the
    // previous rows would show jobs already applied to under "do next".
    expect(buildQueueTab([], NOW)).toHaveLength(1);
  });

  it("marks applied and skipped rows distinctly in the log", () => {
    const applied = buildLogTab([row({ applied_at: new Date() })], NOW)[1]!;
    const skipped = buildLogTab([row({ skipped_at: new Date() })], NOW)[1]!;
    expect(applied).toContain("applied");
    expect(skipped).toContain("skipped");
  });
});
