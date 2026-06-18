/**
 * Daily budget guard — pure function unit tests (no DB, no LLM).
 */

import { describe, it, expect } from "vitest";
import {
  assessDailyBudget,
  checkDailyBudgetGate,
  dailyBudgetLevelLabel,
  formatBudgetDashboard,
  formatBudgetStatusLine,
  formatBudgetThresholdAlert,
  nextBudgetAlertThreshold,
  parseBudgetAlertsState,
  assertDailyBudgetAllowsRun,
  DAILY_BUDGET_WARN_RATIO,
  DailyBudgetExceededError,
} from "../../../src/infra/daily-budget.js";

describe("assessDailyBudget", () => {
  it("reports ok when well under cap", () => {
    const s = assessDailyBudget(1, 5);
    expect(s.level).toBe("ok");
    expect(s.percentUsed).toBe(20);
    expect(s.remainingUsd).toBe(4);
  });

  it("reports warn at 80% threshold", () => {
    const s = assessDailyBudget(4, 5);
    expect(s.level).toBe("warn");
    expect(s.percentUsed).toBe(80);
  });

  it("reports critical above 95%", () => {
    const s = assessDailyBudget(4.8, 5);
    expect(s.level).toBe("critical");
  });

  it("reports exceeded at or above cap", () => {
    expect(assessDailyBudget(5, 5).level).toBe("exceeded");
    expect(assessDailyBudget(6, 5).level).toBe("exceeded");
  });
});

describe("checkDailyBudgetGate", () => {
  it("allows runs when under cap", () => {
    expect(checkDailyBudgetGate(2, 5).ok).toBe(true);
  });

  it("blocks runs when at cap", () => {
    const gate = checkDailyBudgetGate(5, 5);
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.reason).toContain("BUDGET_DAILY_USD");
  });
});

describe("assertDailyBudgetAllowsRun", () => {
  it("fail-opens when spend telemetry is unavailable", async () => {
    await expect(
      assertDailyBudgetAllowsRun(async () => {
        throw new Error("ECONNREFUSED");
      }, 5),
    ).resolves.toBeUndefined();
  });

  it("throws when spend meets cap", async () => {
    await expect(assertDailyBudgetAllowsRun(async () => 5, 5)).rejects.toBeInstanceOf(
      DailyBudgetExceededError,
    );
  });
});

describe("formatBudgetDashboard", () => {
  it("includes daily spend, per-run caps, and blocked notice when exceeded", () => {
    const status = assessDailyBudget(5.5, 5);
    const html = formatBudgetDashboard(status, { maxUsd: 0.5, maxTokens: 50_000 });
    expect(html).toContain("FounderOS Budget");
    expect(html).toContain("blocked");
    expect(html).toContain("0.50");
  });
});

describe("formatBudgetStatusLine", () => {
  it("is a compact line for /status", () => {
    const line = formatBudgetStatusLine(assessDailyBudget(2.5, 5));
    expect(line).toContain("Budget today");
    expect(line).toContain(dailyBudgetLevelLabel("ok"));
  });
});

describe("nextBudgetAlertThreshold", () => {
  it("returns 80 once when crossing warn ratio", () => {
    const status = assessDailyBudget(4, 5);
    expect(status.percentUsed).toBeGreaterThanOrEqual(DAILY_BUDGET_WARN_RATIO * 100);
    expect(nextBudgetAlertThreshold(status, [])).toBe(80);
    expect(nextBudgetAlertThreshold(status, [80])).toBeNull();
  });

  it("returns 100 when exceeded and not yet sent", () => {
    const status = assessDailyBudget(5.1, 5);
    expect(nextBudgetAlertThreshold(status, [80])).toBe(100);
  });
});

describe("formatBudgetThresholdAlert", () => {
  it("warns at 80% with /budget hint", () => {
    const msg = formatBudgetThresholdAlert(assessDailyBudget(4, 5), 80);
    expect(msg).toContain("80%");
    expect(msg).toContain("/budget");
  });

  it("blocks at 100% with cap reached message", () => {
    const msg = formatBudgetThresholdAlert(assessDailyBudget(5, 5), 100);
    expect(msg).toContain("cap reached");
    expect(msg).toContain("blocked");
  });
});

describe("parseBudgetAlertsState", () => {
  it("resets levels when date changes", () => {
    const parsed = parseBudgetAlertsState({ date: "2020-01-01", levels: [80] }, "2026-06-17");
    expect(parsed.levels).toEqual([]);
    expect(parsed.date).toBe("2026-06-17");
  });
});
