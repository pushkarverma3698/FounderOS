/**
 * Unit tests for per-department cost attribution formatters (roadmap #9). Pure, $0.
 */
import { describe, it, expect } from "vitest";
import {
  summarizeDepartmentCost,
  formatDepartmentCostReport,
} from "../../../src/infra/cost-report.js";

describe("summarizeDepartmentCost", () => {
  it("totals, sorts by spend, and computes cost-per-task + share", () => {
    const s = summarizeDepartmentCost([
      { department: "creative", calls: 2, total_cost_usd: "0.268000" },
      { department: "research", calls: 8, total_cost_usd: "0.040000" },
    ]);
    expect(s.totalUsd).toBeCloseTo(0.308, 6);
    expect(s.totalCalls).toBe(10);
    expect(s.costPerTask).toBeCloseTo(0.0308, 6);
    expect(s.byDepartment[0]!.department).toBe("creative"); // highest spend first
    expect(s.byDepartment[0]!.share).toBeCloseTo(0.268 / 0.308, 4);
  });

  it("handles an empty set without dividing by zero", () => {
    const s = summarizeDepartmentCost([]);
    expect(s.totalUsd).toBe(0);
    expect(s.totalCalls).toBe(0);
    expect(s.costPerTask).toBe(0);
    expect(s.byDepartment).toEqual([]);
  });

  it("labels a null department 'unknown'", () => {
    const s = summarizeDepartmentCost([{ department: null, calls: 1, total_cost_usd: "0.01" }]);
    expect(s.byDepartment[0]!.department).toBe("unknown");
  });
});

describe("formatDepartmentCostReport", () => {
  it("renders the cost-per-task headline", () => {
    const out = formatDepartmentCostReport(
      summarizeDepartmentCost([{ department: "creative", calls: 2, total_cost_usd: "0.268" }]),
      7,
    );
    expect(out).toContain("Cost by department");
    expect(out).toContain("creative");
    expect(out).toContain("cost/task");
  });

  it("renders an explicit empty-window message", () => {
    const out = formatDepartmentCostReport(summarizeDepartmentCost([]), 30);
    expect(out).toContain("No costed calls recorded");
    expect(out).toContain("30d");
  });
});
