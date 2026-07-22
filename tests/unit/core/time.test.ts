/**
 * Unit tests — IST clock + recurrence math (pure, frozen clock).
 * The founder is in India; "9am" must mean 9am IST and reminders must re-arm
 * to the right next occurrence with zero LLM.
 */

import { describe, it, expect } from "vitest";
import {
  zoneOffset,
  zoneAbbrev,
  formatInZone,
  plannerNowLine,
  nextRecurrence,
  describeRecurrence,
} from "../../../src/core/time.js";

const IST = "Asia/Kolkata";
// 2026-07-22 13:00 UTC = 18:30 IST, a Wednesday.
const frozen = new Date("2026-07-22T13:00:00Z");
const clock = () => frozen;

describe("time — IST offset + formatting", () => {
  it("reports the fixed +05:30 offset for Asia/Kolkata", () => {
    expect(zoneOffset(frozen, IST)).toBe("+05:30");
  });

  it("labels the zone IST (or the unambiguous offset fallback)", () => {
    expect(zoneAbbrev(frozen, IST)).toMatch(/^IST$|^UTC\+05:30$/);
  });

  it("formats an instant in the founder's wall clock", () => {
    const s = formatInZone(frozen, IST); // 18:30 IST on Wed 22 Jul 2026
    expect(s).toContain("22 Jul 2026");
    expect(s).toContain("6:30 PM");
  });
});

describe("plannerNowLine", () => {
  it("injects the founder's now with offset + interpretation rule", () => {
    const line = plannerNowLine(clock, IST);
    expect(line).toContain("Current time:");
    expect(line).toContain("UTC+05:30");
    expect(line).toMatch(/ISO 8601/);
    expect(line).toMatch(/past/i);
  });
});

describe("nextRecurrence — next fire strictly after now", () => {
  it("daily: a time earlier today rolls to tomorrow 09:00 IST", () => {
    const next = nextRecurrence({ kind: "daily", time: "09:00" }, frozen, IST);
    expect(next.toISOString()).toBe("2026-07-23T03:30:00.000Z"); // Thu 09:00 IST
  });

  it("daily: a time later today stays today", () => {
    const next = nextRecurrence({ kind: "daily", time: "20:00" }, frozen, IST);
    expect(next.toISOString()).toBe("2026-07-22T14:30:00.000Z"); // Wed 20:00 IST
  });

  it("weekdays: Friday evening skips the weekend to Monday", () => {
    const friEve = new Date("2026-07-24T14:00:00Z"); // 19:30 IST Fri
    const next = nextRecurrence({ kind: "weekdays", time: "09:00" }, friEve, IST);
    expect(next.toISOString()).toBe("2026-07-27T03:30:00.000Z"); // Mon 09:00 IST
  });

  it("weekly: from Wednesday finds the next Monday", () => {
    const next = nextRecurrence({ kind: "weekly", weekday: 1, time: "09:00" }, frozen, IST);
    expect(next.toISOString()).toBe("2026-07-27T03:30:00.000Z");
  });
});

describe("describeRecurrence", () => {
  it("labels each kind for the confirmation message", () => {
    expect(describeRecurrence({ kind: "daily", time: "09:00" })).toBe("every day at 09:00");
    expect(describeRecurrence({ kind: "weekdays", time: "18:00" })).toBe("every weekday at 18:00");
    expect(describeRecurrence({ kind: "weekly", weekday: 1, time: "09:00" })).toBe("every Mon at 09:00");
  });
});
