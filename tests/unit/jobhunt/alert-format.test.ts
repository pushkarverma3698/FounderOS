/**
 * Unit tests — B6: the alert carries the action, not just the news.
 *
 * MEASURED. `/draft` and `/applied` were not invoked once in seven days of
 * production logs, against 543 screened rows and 2 lifetime applications. The
 * ping named three companies and then said "→ /jobs for the ranked list" — so
 * acting on it meant reading the alert, running `/jobs`, waiting twenty seconds
 * for a network liveness sweep, scrolling a six-part message to find the same
 * company again, and reading its number off that. Four steps between a
 * notification and the one command that produces an application.
 *
 * So each named row now carries its own `/draft <id>` and its own link. Since the stable-id change (P0-2) the id
 * is the first characters of the row's own uuid, not a `brief_rank`: a position is re-pinned on every render, so
 * `/draft 4` on a 3-day-old alert resolved to a
 * different company. An id resolves to the same one.
 *
 * A ROW WITH NO ID PRINTS NO COMMAND. The id lookup runs after ingest and
 * can fail (it is fail-open by design); when it
 * has, the honest output is the company name with no number next to it, never
 * a guess at what the number would have been.
 */

import { describe, it, expect } from "vitest";
import { formatNewRowsAlert, NEW_ROWS_NAMED } from "../../../src/tools/jobhunt/sweep-heartbeat.js";
import { dedupeKey } from "../../../src/tools/jobhunt/filters.js";
import type { IngestLine } from "../../../src/tools/jobhunt/ingest-batch.js";

function line(over: Partial<IngestLine> = {}): IngestLine {
  return {
    company: "Adyen",
    title: "AI Engineer",
    outcome: "pass",
    detail: "every check cleared",
    isNew: true,
    postedAt: new Date("2026-09-08T10:00:00Z"),
    url: "https://example.com/adyen-ai",
    ...over,
  };
}

/** The rank lookup the sweep builds after ranking, keyed the way the DB is. */
function ids(entries: ReadonlyArray<[IngestLine, string]>): Map<string, string> {
  return new Map(entries.map(([l, id]) => [dedupeKey(l.company, l.title), id]));
}

describe("B6 — every named row carries its own command", () => {
  it("prints /draft with the row's stable id", () => {
    const row = line();
    const msg = formatNewRowsAlert([row], null, "Tashi Goyal", { ids: ids([[row, "j3a9f2c1"]]) });
    expect(msg).toContain("/draft j3a9f2c1");
  });

  it("uses the row's own id, never its position in the alert", () => {
    // THE WHOLE POINT. Numbering the alert 1,2,3 would be a second numbering of
    // the founder's queue, and tapping it would draft for whatever `/jobs` had
    // pinned at 1.
    const a = line({ company: "Adyen" });
    const b = line({ company: "Booking" });
    const msg = formatNewRowsAlert([a, b], null, undefined, { ids: ids([[a, "j81e2aa4"], [b, "j7c0d9e2"]]) });
    expect(msg).toContain("/draft j81e2aa4");
    expect(msg).toContain("/draft j7c0d9e2");
    expect(msg).not.toContain("/draft 1");
    expect(msg).not.toContain("/draft 2");
  });

  it("links the title to the posting", () => {
    const row = line({ url: "https://example.com/adyen-ai" });
    const msg = formatNewRowsAlert([row], null, undefined, { ids: ids([[row, "j3a9f2c1"]]) });
    expect(msg).toContain('href="https://example.com/adyen-ai"');
    expect(msg).toContain("AI Engineer");
  });

  it("keeps the mark matching the outcome", () => {
    const pass = line({ company: "Adyen", outcome: "pass" });
    const flag = line({ company: "Booking", outcome: "flag" });
    const msg = formatNewRowsAlert([pass, flag], null, undefined, {
      ids: ids([[pass, "j3a9f2c1"], [flag, "j81e2aa4"]]),
    });
    expect(msg).toMatch(/✅ .*Adyen/);
    expect(msg).toMatch(/❓ .*Booking/);
  });
});

describe("B6 — an unranked row says less rather than guessing", () => {
  it("names the company with no command when ranking did not pin it", () => {
    const row = line();
    const msg = formatNewRowsAlert([row], null, undefined, { ids: new Map() });
    // Asserted on the ROW's own line. The footer's standing "/draft <n>" hint
    // is a different claim — it tells him the command exists, not which number
    // this company is — and it stays.
    const rowLine = msg.split("\n").find((l) => l.includes("Adyen")) ?? "";
    expect(rowLine).toContain("Adyen");
    expect(rowLine).not.toContain("/draft");
  });

  it("still works with no rank lookup supplied at all", () => {
    // Every pre-existing caller and test passes none. The alert degrades to
    // exactly what it printed before B6 rather than throwing.
    const msg = formatNewRowsAlert([line()], null, "Tashi Goyal");
    expect(msg).toContain("Adyen");
    expect(msg).toContain("🆕");
  });
});

describe("B6 — the alert stays an alert", () => {
  it("still names only the first few rows and counts the rest", () => {
    const rows = Array.from({ length: NEW_ROWS_NAMED + 4 }, (_, i) => line({ company: `C${i}` }));
    const msg = formatNewRowsAlert(rows, null, undefined, { ids: new Map() });
    expect(msg).toContain(`+ 4 more`);
  });

  it("keeps the next-step line for the rows it did not name", () => {
    const rows = Array.from({ length: NEW_ROWS_NAMED + 1 }, (_, i) => line({ company: `C${i}` }));
    expect(formatNewRowsAlert(rows, null, undefined, { ids: new Map() })).toContain("/jobs");
  });
});
