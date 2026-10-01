/**
 * Pace and completion, pure. The plan's boundary list: the due day itself, past due,
 * target 0, and a target already met at creation — plus fractions, very large values
 * and the "no due date is `unknown`, never a made-up pace" rule.
 */

import { describe, it, expect } from "vitest";
import { PACE_AHEAD_MARGIN, computePace, isGoalComplete, type PaceInput } from "../../../src/goals/pace.js";

/** A cumulative goal: 0 → 100 between 1 Sep and 1 Oct (30 days). */
const cumulative = (over: Partial<PaceInput> = {}): PaceInput => ({
  kind: "cumulative",
  value: 0,
  target: 100,
  baseline: 0,
  createdOn: "2026-09-01",
  dueOn: "2026-10-01",
  today: "2026-09-01",
  ...over,
});

const rolling = (over: Partial<PaceInput> = {}): PaceInput => ({
  kind: "rolling",
  value: 0,
  target: 5,
  baseline: 0,
  createdOn: "2026-09-01",
  dueOn: null,
  today: "2026-09-15",
  ...over,
});

describe("computePace — cumulative goals follow a straight line from creation to due date", () => {
  it("on the day it was created, expects the baseline", () => {
    expect(computePace(cumulative({ value: 0 }))).toBe("on_track");
    expect(computePace(cumulative({ value: -1 }))).toBe("behind");
  });

  it("is ahead only when clear of the line by the margin, on track at or above it, behind below it", () => {
    const mid = { today: "2026-09-16" }; // 15 of 30 days: expected 50
    expect(computePace(cumulative({ ...mid, value: 49.99 }))).toBe("behind");
    expect(computePace(cumulative({ ...mid, value: 50 }))).toBe("on_track");
    const marginValue = 50 + PACE_AHEAD_MARGIN * 100;
    expect(computePace(cumulative({ ...mid, value: marginValue - 0.01 }))).toBe("on_track");
    expect(computePace(cumulative({ ...mid, value: marginValue }))).toBe("ahead");
  });

  it("on the due day itself expects the whole target: one short is behind", () => {
    expect(computePace(cumulative({ today: "2026-10-01", value: 99 }))).toBe("behind");
    expect(computePace(cumulative({ today: "2026-10-01", value: 100 }))).toBe("on_track");
  });

  it("past due keeps expecting the whole target and never extrapolates beyond it", () => {
    expect(computePace(cumulative({ today: "2026-10-10", value: 99 }))).toBe("behind");
    expect(computePace(cumulative({ today: "2026-12-31", value: 100 }))).toBe("on_track");
  });

  it("a target already met at creation is ahead, not merely on track", () => {
    expect(computePace(cumulative({ value: 120 }))).toBe("ahead");
    expect(computePace(cumulative({ value: 100 }))).toBe("ahead");
  });

  it("with no due date the pace is `unknown`, never a made-up one — unless the target is already met", () => {
    expect(computePace(cumulative({ dueOn: null, value: 40 }))).toBe("unknown");
    expect(computePace(cumulative({ dueOn: null, value: 0 }))).toBe("unknown");
    expect(computePace(cumulative({ dueOn: null, value: 100 }))).toBe("on_track");
  });

  it("a due date on or before the creation date means it is already due", () => {
    expect(computePace(cumulative({ dueOn: "2026-09-01", value: 10 }))).toBe("behind");
    expect(computePace(cumulative({ dueOn: "2026-08-01", value: 10 }))).toBe("behind");
  });

  it("starts the line at a non-zero baseline", () => {
    const base = { baseline: 50, target: 100 };
    expect(computePace(cumulative({ ...base, value: 50 }))).toBe("on_track");
    expect(computePace(cumulative({ ...base, value: 49 }))).toBe("behind");
    expect(computePace(cumulative({ ...base, value: 55 }))).toBe("ahead");
  });

  it("copes with target 0 without dividing by anything or returning NaN-driven nonsense", () => {
    expect(computePace(cumulative({ target: 0, value: 0 }))).toBe("ahead");
    expect(computePace(cumulative({ target: 0, value: 0, dueOn: null }))).toBe("on_track");
    expect(computePace(cumulative({ target: 0, value: 0, today: "2026-10-01" }))).toBe("on_track");
  });

  it("handles fractional targets", () => {
    const g = { target: 2.5, dueOn: "2026-09-11", today: "2026-09-06" }; // half way: expected 1.25
    expect(computePace(cumulative({ ...g, value: 1.2 }))).toBe("behind");
    expect(computePace(cumulative({ ...g, value: 1.25 }))).toBe("on_track");
  });

  it("handles very large values with no overflow or NaN", () => {
    const g = { target: 1e15, today: "2026-09-16" };
    expect(computePace(cumulative({ ...g, value: 5e14 }))).toBe("on_track");
    expect(computePace(cumulative({ ...g, value: 4.99e14 }))).toBe("behind");
    expect(computePace(cumulative({ ...g, value: 6e14 }))).toBe("ahead");
  });
});

describe("computePace — rolling-window goals compare the latest value to the target", () => {
  it("is behind below the target, on track at it, ahead above it", () => {
    expect(computePace(rolling({ value: 0 }))).toBe("behind");
    expect(computePace(rolling({ value: 4 }))).toBe("behind");
    expect(computePace(rolling({ value: 5 }))).toBe("on_track");
    expect(computePace(rolling({ value: 6 }))).toBe("ahead");
  });

  it("does not need a due date: a rolling goal without one still has a pace", () => {
    expect(computePace(rolling({ dueOn: null, value: 2 }))).toBe("behind");
    expect(computePace(rolling({ dueOn: null, value: 5 }))).toBe("on_track");
  });

  it("ignores the calendar: past due changes the wording, not the comparison", () => {
    expect(computePace(rolling({ dueOn: "2026-09-10", today: "2026-09-29", value: 5 }))).toBe("on_track");
  });

  it("handles target 0 and fractions", () => {
    expect(computePace(rolling({ target: 0, value: 0 }))).toBe("on_track");
    expect(computePace(rolling({ target: 0, value: 1 }))).toBe("ahead");
    expect(computePace(rolling({ target: 2.5, value: 2.5 }))).toBe("on_track");
    expect(computePace(rolling({ target: 2.5, value: 2.4 }))).toBe("behind");
  });
});

describe("computePace — a metric that could not be read has no pace", () => {
  it("is `unknown` for a null or non-finite value, for either kind", () => {
    expect(computePace(rolling({ value: null }))).toBe("unknown");
    expect(computePace(cumulative({ value: null }))).toBe("unknown");
    expect(computePace(rolling({ value: Number.NaN }))).toBe("unknown");
    expect(computePace(cumulative({ value: Number.POSITIVE_INFINITY }))).toBe("unknown");
  });
});

describe("isGoalComplete — when a goal closes itself", () => {
  const done = (over: Partial<Parameters<typeof isGoalComplete>[0]> = {}) =>
    isGoalComplete({ kind: "cumulative", value: 100, target: 100, dueOn: "2026-10-01", today: "2026-09-10", ...over });

  it("closes a cumulative goal the moment its value reaches the target", () => {
    expect(done()).toBe(true);
    expect(done({ value: 99.99 })).toBe(false);
    expect(done({ dueOn: null })).toBe(true);
  });

  it("closes a cumulative goal already met at creation (a value at or above target on day one)", () => {
    expect(done({ value: 150, today: "2026-09-01" })).toBe(true);
  });

  it("keeps a rolling goal open at target: '1 of 1 ✓ on track' is a sustained rate, not a finish line", () => {
    expect(done({ kind: "rolling", value: 1, target: 1, dueOn: "2026-10-31" })).toBe(false);
    expect(done({ kind: "rolling", value: 9, target: 1, dueOn: null })).toBe(false);
  });

  it("closes a rolling goal only once its due date has arrived AND the target is being held", () => {
    const held = { kind: "rolling" as const, value: 5, target: 5, dueOn: "2026-10-31" };
    expect(isGoalComplete({ ...held, today: "2026-10-30" })).toBe(false);
    expect(isGoalComplete({ ...held, today: "2026-10-31" })).toBe(true);
    expect(isGoalComplete({ ...held, today: "2026-11-05" })).toBe(true);
    expect(isGoalComplete({ ...held, value: 4, today: "2026-11-05" })).toBe(false);
  });

  it("never closes on a value that could not be read", () => {
    expect(done({ value: null })).toBe(false);
    expect(done({ value: Number.NaN })).toBe(false);
  });

  it("treats target 0 as met by any value at or above it", () => {
    expect(done({ target: 0, value: 0 })).toBe(true);
  });
});
