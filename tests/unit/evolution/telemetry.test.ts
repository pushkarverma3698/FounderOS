/**
 * M0a — Evolution Engine v0: telemetry static analyzers unit tests.
 * =================================================================
 * Unit tests covering true-positive and false-positive cases for cost hotspots,
 * recurring failure patterns, and unapplied lessons. Fixtures only — no DB.
 */

import { describe, expect, it } from "vitest";
import {
  findCostHotspots,
  findRecurringFailures,
  findUnappliedLessons,
  type CostRow,
  type LessonRow,
} from "../../../src/evolution/analyzers/telemetry.js";

const costRow = (
  agent: string,
  model: string,
  cost_usd: number,
  tokens_in = 1000,
  tokens_out = 500,
): CostRow => ({
  agent,
  model,
  cost_usd,
  tokens_in,
  tokens_out,
});

const lessonRow = (
  worker: string,
  signature: string,
  component: string,
  times_seen: number,
  times_applied: number,
  // Defaults to a PROVEN lesson (resolved at least once), which is what every
  // pre-2026-08-12 row was and what these fixtures were written to describe.
  times_resolved = 1,
): LessonRow => ({
  worker,
  signature,
  component,
  times_seen,
  times_resolved,
  times_applied,
});

describe("findCostHotspots", () => {
  it("flags a pair holding 40% of spend", () => {
    const rows: CostRow[] = [
      costRow("admin", "gemini-flash-latest", 12.4),
      costRow("outreach", "gemini-pro", 5.0),
      costRow("research", "claude-sonnet", 5.0),
      costRow("marketing", "gpt-4o", 5.0),
      costRow("support", "claude-haiku", 3.7),
    ];

    const findings = findCostHotspots(rows);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: "cost-hotspot",
      subject: "admin:gemini-flash-latest",
      severity: "medium",
    });
    expect(findings[0]?.evidence).toContain("12.40");
    expect(findings[0]?.evidence).toContain("31.10");
    expect(findings[0]?.evidence).toContain("40%");
  });

  it("does NOT flag five evenly-split pairs at 20% each", () => {
    const rows: CostRow[] = [
      costRow("agent1", "modelA", 10),
      costRow("agent2", "modelB", 10),
      costRow("agent3", "modelC", 10),
      costRow("agent4", "modelD", 10),
      costRow("agent5", "modelE", 10),
    ];

    expect(findCostHotspots(rows)).toEqual([]);
  });

  it("returns [] for an empty array and when every row has cost_usd: 0", () => {
    expect(findCostHotspots([])).toEqual([]);

    const zeroRows: CostRow[] = [
      costRow("admin", "modelA", 0),
      costRow("outreach", "modelB", 0),
    ];
    expect(findCostHotspots(zeroRows)).toEqual([]);
  });

  it("sorts two hotspots with the more expensive one first", () => {
    const rows: CostRow[] = [
      costRow("minor", "modelA", 15), // 15%
      costRow("hotspotB", "modelB", 35), // 35%
      costRow("hotspotA", "modelC", 50), // 50%
    ];

    const findings = findCostHotspots(rows);

    expect(findings).toHaveLength(2);
    expect(findings[0]?.subject).toBe("hotspotA:modelC");
    expect(findings[0]?.severity).toBe("high");
    expect(findings[1]?.subject).toBe("hotspotB:modelB");
    expect(findings[1]?.severity).toBe("medium");
    expect(findings[0]?.evidence).toContain("across 1 call.");
  });
});

describe("findRecurringFailures", () => {
  it("flags a component with 3 distinct signatures", () => {
    const rows: LessonRow[] = [
      lessonRow("email_worker", "SIG_TIMEOUT", "src/tools/email.ts", 1, 0),
      lessonRow("email_worker", "SIG_AUTH_401", "src/tools/email.ts", 1, 0),
      lessonRow("email_worker", "SIG_DNS_FAIL", "src/tools/email.ts", 1, 0),
    ];

    const findings = findRecurringFailures(rows);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: "recurring-failure",
      subject: "src/tools/email.ts",
      severity: "medium",
    });
    expect(findings[0]?.evidence).toContain("src/tools/email.ts");
    expect(findings[0]?.evidence).toContain("3 distinct signatures");
  });

  it("does NOT flag a component with 5 rows that all share one signature", () => {
    const rows: LessonRow[] = [
      lessonRow("workerA", "SAME_SIG", "src/tools/db.ts", 1, 0),
      lessonRow("workerA", "SAME_SIG", "src/tools/db.ts", 2, 0),
      lessonRow("workerA", "SAME_SIG", "src/tools/db.ts", 3, 0),
      lessonRow("workerB", "SAME_SIG", "src/tools/db.ts", 4, 0),
      lessonRow("workerB", "SAME_SIG", "src/tools/db.ts", 5, 0),
    ];

    expect(findRecurringFailures(rows)).toEqual([]);
  });
});

describe("findUnappliedLessons", () => {
  it("flags times_seen: 4, times_applied: 0 with high severity", () => {
    const rows: LessonRow[] = [
      lessonRow("sales_worker", "SIG_RATE_LIMIT", "src/tools/sales.ts", 4, 0),
    ];

    const findings = findUnappliedLessons(rows);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: "unapplied-lesson",
      subject: "sales_worker:SIG_RATE_LIMIT",
      severity: "high",
    });
    expect(findings[0]?.evidence).toContain("4 times");
    expect(findings[0]?.evidence).toContain("never been injected");
    expect(findings[0]?.evidence).toContain("known fix");
  });

  it("sorts by times_seen descending — the worst broken lesson reads first", () => {
    const rows: LessonRow[] = [
      lessonRow("a", "SIG_MINOR", "c", 3, 0),
      lessonRow("b", "SIG_WORST", "c", 47, 0),
      lessonRow("c", "SIG_MID", "c", 9, 0),
    ];

    const findings = findUnappliedLessons(rows);

    expect(findings.map((f) => f.subject)).toEqual(["b:SIG_WORST", "c:SIG_MID", "a:SIG_MINOR"]);
  });

  it("does NOT flag times_seen: 4, times_applied: 1", () => {
    const rows: LessonRow[] = [
      lessonRow("sales_worker", "SIG_RATE_LIMIT", "src/tools/sales.ts", 4, 1),
    ];

    expect(findUnappliedLessons(rows)).toEqual([]);
  });

  it("does NOT flag times_seen: 2, times_applied: 0", () => {
    const rows: LessonRow[] = [
      lessonRow("sales_worker", "SIG_RATE_LIMIT", "src/tools/sales.ts", 2, 0),
    ];

    expect(findUnappliedLessons(rows)).toEqual([]);
  });

  // REGRESSION (2026-08-12): the occurrence axis introduced rows with
  // times_resolved = 0 — a signature that failed repeatedly and was NEVER
  // fixed. There is no lesson to inject, and getFailureLesson deliberately
  // refuses to return them, so reporting them as "never injected" would flag
  // the injection gate working correctly as a high-severity defect. These rows
  // are the COMMON case, so unfiltered they would swamp the audit report.
  it("does NOT flag an occurrence-only row (times_resolved: 0) — no fix exists to inject", () => {
    const rows: LessonRow[] = [
      lessonRow("sales_worker", "SIG_NEVER_FIXED", "src/tools/sales.ts", 40, 0, 0),
    ];

    expect(findUnappliedLessons(rows)).toEqual([]);
  });

  it("still flags a PROVEN lesson (times_resolved > 0) that is never injected", () => {
    const rows: LessonRow[] = [
      lessonRow("sales_worker", "SIG_HAS_FIX", "src/tools/sales.ts", 9, 0, 3),
    ];

    const findings = findUnappliedLessons(rows);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("high");
    expect(findings[0]?.evidence).toContain("resolved 3");
  });

  it("separates the two axes: occurrence-only rows are dropped, proven ones kept", () => {
    const rows: LessonRow[] = [
      lessonRow("a", "SIG_NEVER_FIXED", "c", 99, 0, 0),
      lessonRow("b", "SIG_HAS_FIX", "c", 5, 0, 2),
      lessonRow("c", "SIG_ALSO_NEVER", "c", 60, 0, 0),
    ];

    expect(findUnappliedLessons(rows).map((f) => f.subject)).toEqual(["b:SIG_HAS_FIX"]);
  });
});
