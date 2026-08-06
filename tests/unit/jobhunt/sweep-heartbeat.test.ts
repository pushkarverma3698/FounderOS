/**
 * Unit tests — proof that the free lane is alive.
 *
 * THE TWO FAILURES THIS SITS BETWEEN. A healthy lane with a quiet market sends
 * nothing; a broken lane that polled zero boards ALSO sends nothing. Fixing that
 * by messaging every sweep produces 48 identical pings a day, which trains the
 * founder to swipe the channel away — and the one message that mattered goes
 * with the rest. Both directions are silent failures, so both are pinned here.
 */

import { describe, it, expect } from "vitest";
import type { IngestLine } from "../../../src/tools/jobhunt/ingest-batch.js";
import {
  ALIVE_PING_INTERVAL_MS,
  afterQuietSweep,
  afterSpokenSweep,
  formatNewRowsAlert,
  initialHeartbeat,
  sheetLine,
} from "../../../src/tools/jobhunt/sweep-heartbeat.js";

const START = new Date("2026-08-06T00:00:00Z");
const LINK = "📊 link";

function at(msFromStart: number): Date {
  return new Date(START.getTime() + msFromStart);
}

function pass(overrides: Partial<IngestLine> = {}): IngestLine {
  return {
    company: "Aquablu B.V.",
    title: "Embedded Software Engineer",
    outcome: "pass",
    detail: "",
    isNew: true,
    ...overrides,
  };
}

describe("afterQuietSweep", () => {
  it("stays silent inside the ping interval, however many sweeps run", () => {
    let state = initialHeartbeat(START);
    for (let i = 1; i <= 5; i++) {
      const step = afterQuietSweep(state, 285, at(i * 30 * 60 * 1000), LINK);
      expect(step.ping).toBeNull();
      state = step.next;
    }
    expect(state.quietSweeps).toBe(5);
  });

  it("pings once the interval has passed, and counts every sweep since", () => {
    let state = initialHeartbeat(START);
    state = afterQuietSweep(state, 285, at(30 * 60 * 1000), LINK).next;
    const due = afterQuietSweep(state, 285, at(ALIVE_PING_INTERVAL_MS), LINK);

    expect(due.ping).not.toBeNull();
    expect(due.ping).toContain("2 sweeps");
    // The boards count is the EVIDENCE behind the claim. A ping that said only
    // "alive" would still be sent by a lane whose registry had shrunk to zero.
    expect(due.ping).toContain("570");
  });

  it("resets the counters after pinging, so the next ping is not cumulative", () => {
    const state = afterQuietSweep(initialHeartbeat(START), 285, at(ALIVE_PING_INTERVAL_MS), LINK);
    expect(state.next.quietSweeps).toBe(0);
    expect(state.next.boardsPolled).toBe(0);
  });

  it("carries the sheet link so the ping ends in something actionable", () => {
    const due = afterQuietSweep(initialHeartbeat(START), 1, at(ALIVE_PING_INTERVAL_MS), LINK);
    expect(due.ping).toContain(LINK);
  });

  it("still pings when the sheet link is unknown", () => {
    // A missing link must not cost the founder the proof-of-life itself.
    const due = afterQuietSweep(initialHeartbeat(START), 1, at(ALIVE_PING_INTERVAL_MS), null);
    expect(due.ping).toContain("alive");
  });
});

describe("afterSpokenSweep", () => {
  it("resets the clock, so a real alert is not chased by a redundant ping", () => {
    const spoken = afterSpokenSweep(at(ALIVE_PING_INTERVAL_MS));
    const next = afterQuietSweep(spoken, 285, at(ALIVE_PING_INTERVAL_MS + 60_000), LINK);
    expect(next.ping).toBeNull();
  });
});

describe("formatNewRowsAlert", () => {
  it("names the first three roles and totals the rest", () => {
    const rows = Array.from({ length: 8 }, (_, i) => pass({ company: `Company ${i}` }));
    const text = formatNewRowsAlert(rows, LINK);

    expect(text).toContain("8 new roles");
    expect(text).toContain("Company 0");
    expect(text).toContain("Company 2");
    expect(text).not.toContain("Company 3");
    expect(text).toContain("+ 5 more");
  });

  it("says 'role' not 'roles' for a single row", () => {
    expect(formatNewRowsAlert([pass()], LINK)).toContain("1 new role passed");
  });

  it("escapes company names so Telegram cannot reject the whole message", () => {
    // Real prod title, 2026-07-31: "Bloom & Wild Group". Telegram rejects the
    // ENTIRE message on one unparseable entity, so an unescaped ampersand loses
    // the founder the alert, not just the character.
    const text = formatNewRowsAlert([pass({ company: "Bloom & Wild <Group>" })], LINK);
    expect(text).toContain("Bloom &amp; Wild");
    expect(text).not.toContain("<Group>");
  });

  it("never invents a /draft number", () => {
    // The numbering lives in the sheet's # column, pinned to brief_rank. A
    // second scheme here would resolve to the wrong row.
    expect(formatNewRowsAlert([pass()], LINK)).not.toMatch(/\/draft \d/);
  });
});

describe("sheetLine", () => {
  it("is null when there is no sheet, so callers can tell", () => {
    expect(sheetLine(null)).toBeNull();
  });

  it("renders a tappable link", () => {
    expect(sheetLine("https://docs.google.com/spreadsheets/d/X")).toContain("<a href=");
  });
});
