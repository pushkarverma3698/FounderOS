/**
 * Monthly recurrence + spec parsing.
 *
 * `scheduled_tasks` was one-shot only, so recurring campaign routines had no
 * durable home. Rather than add a second recurrence engine, the existing
 * reminder recurrence in core/time.ts gains `monthly` and a spec parser — it
 * already handles IANA timezones correctly, which a fixed-offset rewrite would not.
 */

import { describe, it, expect } from "vitest";
import { parseRecurrence, nextRecurrence, describeRecurrence } from "../../../src/core/time.js";

const IST = "Asia/Kolkata";

describe("parseRecurrence", () => {
  it("parses each supported form", () => {
    expect(parseRecurrence("daily@08:07")).toEqual({ kind: "daily", time: "08:07" });
    expect(parseRecurrence("weekdays@09:00")).toEqual({ kind: "weekdays", time: "09:00" });
    expect(parseRecurrence("weekly@mon:09:12")).toEqual({
      kind: "weekly",
      weekday: 1,
      time: "09:12",
    });
    expect(parseRecurrence("monthly@01:06:07")).toEqual({
      kind: "monthly",
      day: 1,
      time: "06:07",
    });
  });

  it("maps every weekday key", () => {
    expect(parseRecurrence("weekly@sun:10:07")?.kind).toBe("weekly");
    expect((parseRecurrence("weekly@sun:10:07") as { weekday: number }).weekday).toBe(0);
    expect((parseRecurrence("weekly@sat:10:07") as { weekday: number }).weekday).toBe(6);
  });

  it("returns null for malformed specs rather than guessing", () => {
    for (const bad of [
      "", "daily", "daily@25:00", "daily@08:60", "weekly@xyz:09:00",
      "monthly@32:01:00", "monthly@00:01:00", "hourly@07:00", "daily@8:7",
    ]) {
      expect(parseRecurrence(bad)).toBeNull();
    }
  });
});

describe("nextRecurrence — monthly", () => {
  it("finds the 1st of next month once this month's slot has passed", () => {
    const rec = parseRecurrence("monthly@01:06:07")!;
    const next = nextRecurrence(rec, new Date("2026-07-29T00:00:00Z"), IST);
    // 1 Aug 2026 06:07 IST = 00:37Z
    expect(next.toISOString()).toBe("2026-08-01T00:37:00.000Z");
  });

  it("clamps day 31 into a short month instead of skipping it", () => {
    const rec = parseRecurrence("monthly@31:09:00")!;
    const next = nextRecurrence(rec, new Date("2026-09-15T00:00:00Z"), IST);
    // 30 Sep 2026 09:00 IST = 03:30Z — September, not October
    expect(next.toISOString()).toBe("2026-09-30T03:30:00.000Z");
  });

  it("is always strictly after the reference instant", () => {
    const rec = parseRecurrence("monthly@01:06:07")!;
    const exact = new Date("2026-08-01T00:37:00.000Z");
    expect(nextRecurrence(rec, exact, IST).getTime()).toBeGreaterThan(exact.getTime());
  });
});

describe("describeRecurrence", () => {
  it("labels a monthly recurrence", () => {
    expect(describeRecurrence({ kind: "monthly", day: 1, time: "06:07" })).toBe(
      "on day 1 of each month at 06:07",
    );
  });
});
