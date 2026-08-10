/**
 * Unit tests — the hard spend cap on the job sweep.
 *
 * Apify bills this account on a FREE plan with a $5 hard platform cap, shared
 * with the research actors. On 2026-08-05 the cycle stood at $3.28 of $5 with
 * two sweeps still scheduled, and nothing in the pipeline could refuse to spend:
 * the sweep ran whatever the balance was, and the only thing standing between a
 * runaway month and a dead account was the cadence.
 *
 * The gate is a PURE decision over three numbers so it can be tested without a
 * database and cannot disagree with itself between the planner and the ledger.
 */

import { describe, it, expect } from "vitest";
import {
  DEFAULT_MONTHLY_CAP_USD,
  DEFAULT_CYCLE_START_DAY,
  capFromEnv,
  cycleStartDayFromEnv,
  cycleStart,
  decideSweep,
} from "../../../src/tools/jobhunt/spend-gate.js";

describe("decideSweep", () => {
  const cap = 2.0;

  it("allows a sweep that fits inside the cap", () => {
    const d = decideSweep({ spentUsd: 1.0, projectedUsd: 0.3, capUsd: cap });
    expect(d.ok).toBe(true);
    expect(d.remainingUsd).toBeCloseTo(1.0, 6);
  });

  it("allows a sweep that lands exactly on the cap", () => {
    // The cap is a ceiling, not a line to stay under. Refusing here would make
    // the last affordable sweep of every cycle unreachable.
    expect(decideSweep({ spentUsd: 1.7, projectedUsd: 0.3, capUsd: cap }).ok).toBe(true);
  });

  it("refuses a sweep that would cross the cap", () => {
    const d = decideSweep({ spentUsd: 1.9, projectedUsd: 0.3, capUsd: cap });
    expect(d.ok).toBe(false);
    expect(d.reason).toContain("$2.00");
  });

  it("says what it would have cost and what is left, not just no", () => {
    // A refusal the founder cannot act on is the same silent failure in a new
    // costume: he needs to know whether to raise the cap or wait for the cycle.
    const d = decideSweep({ spentUsd: 1.9, projectedUsd: 0.3, capUsd: cap });
    expect(d.reason).toContain("0.30");
    expect(d.reason).toContain("0.10");
  });

  it("refuses when the cycle is already over cap", () => {
    const d = decideSweep({ spentUsd: 2.4, projectedUsd: 0.3, capUsd: cap });
    expect(d.ok).toBe(false);
    expect(d.remainingUsd).toBe(0);
  });

  it("refuses everything when the cap is zero", () => {
    // The documented way to pause spend without editing the schedule.
    expect(decideSweep({ spentUsd: 0, projectedUsd: 0.01, capUsd: 0 }).ok).toBe(false);
  });

  it("never reports negative headroom", () => {
    expect(decideSweep({ spentUsd: 9, projectedUsd: 0.3, capUsd: cap }).remainingUsd).toBe(0);
  });
});

describe("capFromEnv", () => {
  it("defaults to the documented cap when unset", () => {
    expect(capFromEnv({})).toBe(DEFAULT_MONTHLY_CAP_USD);
  });

  it("reads an explicit cap", () => {
    expect(capFromEnv({ JOBHUNT_MONTHLY_CAP_USD: "3.50" })).toBe(3.5);
  });

  it("allows zero as a deliberate freeze", () => {
    expect(capFromEnv({ JOBHUNT_MONTHLY_CAP_USD: "0" })).toBe(0);
  });

  it("falls back to the default rather than trusting a garbage value", () => {
    // A typo in .env must not silently become an unlimited budget.
    expect(capFromEnv({ JOBHUNT_MONTHLY_CAP_USD: "lots" })).toBe(DEFAULT_MONTHLY_CAP_USD);
    expect(capFromEnv({ JOBHUNT_MONTHLY_CAP_USD: "-5" })).toBe(DEFAULT_MONTHLY_CAP_USD);
  });
});

describe("cycleStart", () => {
  // The Apify billing cycle observed on this account runs the 11th to the 10th,
  // so a calendar month would measure the wrong window and permit a double spend
  // across the boundary.
  it("uses this month's start day once the day has passed", () => {
    expect(cycleStart(new Date("2026-08-05T09:00:00Z"), 11)).toEqual(
      new Date("2026-07-11T00:00:00Z"),
    );
  });

  it("rolls back to last month before the start day", () => {
    expect(cycleStart(new Date("2026-08-20T09:00:00Z"), 11)).toEqual(
      new Date("2026-08-11T00:00:00Z"),
    );
  });

  it("treats the start day itself as the beginning of the new cycle", () => {
    expect(cycleStart(new Date("2026-08-11T00:30:00Z"), 11)).toEqual(
      new Date("2026-08-11T00:00:00Z"),
    );
  });

  it("crosses a year boundary without losing the month", () => {
    expect(cycleStart(new Date("2027-01-05T09:00:00Z"), 11)).toEqual(
      new Date("2026-12-11T00:00:00Z"),
    );
  });

  it("defaults to the observed billing day", () => {
    expect(cycleStartDayFromEnv({})).toBe(DEFAULT_CYCLE_START_DAY);
    expect(cycleStartDayFromEnv({ APIFY_CYCLE_START_DAY: "1" })).toBe(1);
    expect(cycleStartDayFromEnv({ APIFY_CYCLE_START_DAY: "99" })).toBe(DEFAULT_CYCLE_START_DAY);
  });
});
