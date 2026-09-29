/**
 * Local dates. `review_date` is the date in the APP timezone, not UTC: at 23:30 UTC
 * it is already tomorrow in Amsterdam, and a standup keyed on the UTC date would
 * either fire twice for one local day or skip one.
 */

import { describe, it, expect } from "vitest";
import {
  addDays,
  daysBetween,
  formatDayLabel,
  formatShortDate,
  isValidDateKey,
  localDateKey,
  localMinutesOfDay,
  startOfLocalDay,
} from "../../../src/goals/local-date.js";

const AMS = "Europe/Amsterdam";

describe("localDateKey — the date an instant falls on in a zone", () => {
  it("23:30 UTC is already TOMORROW in Amsterdam (summer, +2)", () => {
    const at = new Date("2026-09-29T23:30:00Z");
    expect(localDateKey(at, "UTC")).toBe("2026-09-29");
    expect(localDateKey(at, AMS)).toBe("2026-09-30");
  });

  it("23:30 UTC is tomorrow in Amsterdam in winter too (+1), across a year boundary", () => {
    expect(localDateKey(new Date("2026-12-31T23:30:00Z"), AMS)).toBe("2027-01-01");
  });

  it("flips exactly at local midnight, not an hour either side", () => {
    expect(localDateKey(new Date("2026-09-29T21:59:59Z"), AMS)).toBe("2026-09-29");
    expect(localDateKey(new Date("2026-09-29T22:00:00Z"), AMS)).toBe("2026-09-30");
    expect(localDateKey(new Date("2026-09-29T18:29:59Z"), "Asia/Kolkata")).toBe("2026-09-29");
    expect(localDateKey(new Date("2026-09-29T18:30:00Z"), "Asia/Kolkata")).toBe("2026-09-30");
  });

  it("goes the other way for zones behind UTC: 06:59 UTC is still yesterday in Los Angeles", () => {
    expect(localDateKey(new Date("2026-09-30T06:59:59Z"), "America/Los_Angeles")).toBe("2026-09-29");
    expect(localDateKey(new Date("2026-09-30T07:00:00Z"), "America/Los_Angeles")).toBe("2026-09-30");
  });

  it("throws on an unknown zone instead of quietly using UTC", () => {
    expect(() => localDateKey(new Date(), "Mars/Olympus")).toThrow();
  });
});

describe("localMinutesOfDay — is it 09:00 yet", () => {
  it("reads 09:00 as 540 in Amsterdam in both summer and winter time", () => {
    expect(localMinutesOfDay(new Date("2026-09-29T07:00:00Z"), AMS)).toBe(540);
    expect(localMinutesOfDay(new Date("2026-12-01T08:00:00Z"), AMS)).toBe(540);
  });

  it("reads local midnight as 0, not 1440 (the hour-24 quirk)", () => {
    expect(localMinutesOfDay(new Date("2026-09-29T22:00:00Z"), AMS)).toBe(0);
    expect(localMinutesOfDay(new Date("2026-09-29T21:59:00Z"), AMS)).toBe(23 * 60 + 59);
  });
});

describe("startOfLocalDay — the instant a local day begins", () => {
  it("is 22:00 UTC the evening before, in Amsterdam summer time", () => {
    expect(startOfLocalDay("2026-09-30", AMS).toISOString()).toBe("2026-09-29T22:00:00.000Z");
  });

  it("is 23:00 UTC the evening before in Amsterdam winter time", () => {
    expect(startOfLocalDay("2026-12-01", AMS).toISOString()).toBe("2026-11-30T23:00:00.000Z");
  });

  it("handles fractional and behind-UTC zones", () => {
    expect(startOfLocalDay("2026-09-30", "Asia/Kolkata").toISOString()).toBe("2026-09-29T18:30:00.000Z");
    expect(startOfLocalDay("2026-09-30", "America/Los_Angeles").toISOString()).toBe("2026-09-30T07:00:00.000Z");
    expect(startOfLocalDay("2026-09-30", "Pacific/Auckland").toISOString()).toBe("2026-09-29T11:00:00.000Z");
  });

  it("is right on the two DST-change days, where the day is 23 or 25 hours long", () => {
    expect(startOfLocalDay("2026-03-29", AMS).toISOString()).toBe("2026-03-28T23:00:00.000Z");
    expect(startOfLocalDay("2026-10-25", AMS).toISOString()).toBe("2026-10-24T22:00:00.000Z");
  });

  it("round-trips with localDateKey: the first instant of a day is on that day, the instant before is not", () => {
    for (const zone of [AMS, "Asia/Kolkata", "America/Los_Angeles", "Pacific/Auckland"]) {
      const start = startOfLocalDay("2026-10-05", zone);
      expect(localDateKey(start, zone), zone).toBe("2026-10-05");
      expect(localDateKey(new Date(start.getTime() - 1), zone), zone).toBe("2026-10-04");
    }
  });
});

describe("date keys — validation and arithmetic", () => {
  it("accepts real calendar dates only", () => {
    expect(isValidDateKey("2026-09-29")).toBe(true);
    expect(isValidDateKey("2028-02-29")).toBe(true);
    for (const bad of ["2026-02-29", "2026-02-30", "2026-13-01", "2026-00-10", "2026-09-31", "26-09-29", "2026-9-29", "2026-09-29T00:00", "", "tomorrow"]) {
      expect(isValidDateKey(bad), bad).toBe(false);
    }
  });

  it("counts whole days between two keys, negative when reversed", () => {
    expect(daysBetween("2026-09-29", "2026-10-31")).toBe(32);
    expect(daysBetween("2026-09-29", "2026-09-29")).toBe(0);
    expect(daysBetween("2026-10-31", "2026-09-29")).toBe(-32);
    expect(daysBetween("2026-03-28", "2026-03-30")).toBe(2); // across a DST change
  });

  it("adds days across month and year ends", () => {
    expect(addDays("2026-09-29", 3)).toBe("2026-10-02");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("labels a day the way the standup header prints it", () => {
    expect(formatDayLabel("2026-09-30")).toBe("Wed 30 Sep");
    expect(formatDayLabel("2026-10-05")).toBe("Mon 5 Oct");
    expect(formatShortDate("2026-10-31")).toBe("31 Oct");
  });
});
