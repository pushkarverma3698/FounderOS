/**
 * Unit tests — A5: 🆕 means newly PUBLISHED, not newly noticed by us.
 *
 * THE DEFECT. `runFreeSweepForProfile` filtered on `line.isNew`, which is a
 * fact about our tracker (`existing === null` in screen.ts), not about the
 * employer. The two coincide on a steady day — median discovery lag is twelve
 * minutes — and diverge exactly when a BOARD is added: every posting on a new
 * board is `isNew`, including ones published a month ago, and all of them
 * pinged as 🆕.
 *
 * That matters because the alert exists to make the founder stop what he is
 * doing. The board registry went 1,312 → 3,223 on 2026-09-08; on the sweeps
 * after an import, "🆕 40 new roles" meant "we can now see 40 roles, most of
 * them stale". An interrupt that is right about a category and wrong about
 * urgency is how a channel gets muted, and this channel is the only thing
 * standing between a screened role and no application.
 *
 * So the split is on PUBLICATION age, and each half gets the volume it earns:
 * genuinely fresh roles interrupt, backfill is a quiet line, and — unlike the
 * first draft of this fix — backfill is never simply dropped when both exist.
 * A count nobody prints is a count nobody can question.
 */

import { describe, it, expect } from "vitest";
import {
  splitByPublishFreshness,
  formatBackfillLine,
  formatNewRowsAlert,
  PUBLISH_FRESH_HOURS,
} from "../../../src/tools/jobhunt/sweep-heartbeat.js";
import type { IngestLine } from "../../../src/tools/jobhunt/ingest-batch.js";

const NOW = new Date("2026-09-08T12:00:00Z");

function line(over: Partial<IngestLine> = {}): IngestLine {
  return {
    company: "Adyen",
    title: "AI Engineer",
    outcome: "pass",
    detail: "every check cleared",
    isNew: true,
    postedAt: new Date("2026-09-08T10:00:00Z"),
    url: "https://example.com/1",
    ...over,
  };
}

function hoursAgo(h: number): Date {
  return new Date(NOW.getTime() - h * 3_600_000);
}

describe("A5 — the split is on publication age", () => {
  it("calls a two-hour-old posting fresh", () => {
    const split = splitByPublishFreshness([line({ postedAt: hoursAgo(2) })], NOW);
    expect(split.fresh).toHaveLength(1);
    expect(split.backfill).toHaveLength(0);
  });

  it("calls a thirteen-day-old posting backfill, however new it is to us", () => {
    const split = splitByPublishFreshness([line({ postedAt: hoursAgo(13 * 24) })], NOW);
    expect(split.fresh).toHaveLength(0);
    expect(split.backfill).toHaveLength(1);
  });

  it("splits a mixed sweep on the hour boundary, not on isNew", () => {
    const rows = [
      line({ company: "A", postedAt: hoursAgo(1) }),
      line({ company: "B", postedAt: hoursAgo(PUBLISH_FRESH_HOURS + 1) }),
      line({ company: "C", postedAt: hoursAgo(PUBLISH_FRESH_HOURS - 1) }),
    ];
    const split = splitByPublishFreshness(rows, NOW);
    expect(split.fresh.map((r) => r.company)).toEqual(["A", "C"]);
    expect(split.backfill.map((r) => r.company)).toEqual(["B"]);
  });

  it("treats a posting with no stated date as fresh, not as backfill", () => {
    // An unknown publication date is not evidence of age. Demoting it to a
    // quiet line would silence every source that omits the field — including
    // `screen_job`, the founder pasting a posting he found himself, which is
    // the one row he already knows is current.
    const split = splitByPublishFreshness([line({ postedAt: null })], NOW);
    expect(split.fresh).toHaveLength(1);
    expect(split.backfill).toHaveLength(0);
  });
});

describe("A5 — each half gets the volume it earns", () => {
  it("interrupts for a genuinely fresh role, with the 🆕 mark", () => {
    const msg = formatNewRowsAlert([line({ postedAt: hoursAgo(2) })], null, "Tashi Goyal");
    expect(msg).toContain("🆕");
    expect(msg).toContain("Adyen");
  });

  it("reports backfill without an emoji and without the word 'new'", () => {
    const quiet = formatBackfillLine(12, "Tashi Goyal");
    expect(quiet).toContain("12");
    expect(quiet).toContain("Tashi Goyal");
    expect(quiet).not.toContain("🆕");
    expect(quiet.toLowerCase()).not.toContain("new role");
  });

  it("uses the singular for one backfilled role", () => {
    expect(formatBackfillLine(1, "Tashi Goyal")).toContain("1 older role");
  });

  it("still names what to do next — a quiet line is not a dead end", () => {
    expect(formatBackfillLine(12, "Tashi Goyal")).toContain("/jobs");
  });
});

describe("A5 — backfill is never silently dropped", () => {
  it("carries the backfill count inside the alert when both halves exist", () => {
    // Deliberately WIDER than the AG-014 brief, which sends the quiet line only
    // when there are no fresh roles. Under that rule a sweep with 1 fresh and
    // 40 backfilled roles reports the 1 and says nothing about the 40 — a
    // silent drop, which is the exact defect class this audit is closing.
    const msg = formatNewRowsAlert([line({ postedAt: hoursAgo(2) })], null, "Tashi Goyal", {
      backfill: 40,
    });
    expect(msg).toContain("40");
    expect(msg.toLowerCase()).toContain("older");
  });

  it("says nothing extra when there was no backfill", () => {
    const msg = formatNewRowsAlert([line({ postedAt: hoursAgo(2) })], null, "Tashi Goyal", {
      backfill: 0,
    });
    expect(msg.toLowerCase()).not.toContain("older");
  });

  it("counts the fresh half in the headline, never the whole sweep", () => {
    const msg = formatNewRowsAlert([line({ postedAt: hoursAgo(2) })], null, "Tashi Goyal", {
      backfill: 40,
    });
    expect(msg).toContain("1 new role");
    expect(msg).not.toContain("41 new");
  });
});
