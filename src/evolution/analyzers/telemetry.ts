/**
 * M0a — Evolution Engine v0: telemetry static analyzers.
 * =======================================================
 * Pure analyzers inspecting cost hotspots, recurring failure patterns, and
 * unapplied failure lessons over pre-fetched database row fixtures.
 */

import type { CostRow, Finding, LessonRow, Severity } from "../types.js";

export type { CostRow, LessonRow } from "../types.js";

/** An agent+model pair at or above this share of window spend is the cost lever. */
export const COST_HOTSPOT_SHARE = 0.25;

/** Distinct failure signatures against one component before it is a pattern, not noise. */
export const RECURRING_FAILURE_MIN_SIGNATURES = 3;

/** Times a lesson must have been seen before "never applied" is a real defect. */
export const UNAPPLIED_LESSON_MIN_SEEN = 3;

interface GroupedCost {
  readonly agent: string;
  readonly model: string;
  readonly key: string;
  cost: number;
  calls: number;
}

/**
 * Identify agent+model pairs accounting for >=25% of total spend in the window.
 * Returns findings sorted by cost descending. Returns [] for empty input or 0 total spend.
 */
export function findCostHotspots(rows: readonly CostRow[]): Finding[] {
  if (rows.length === 0) return [];

  let totalSpend = 0;
  const groups = new Map<string, GroupedCost>();

  for (const row of rows) {
    totalSpend += row.cost_usd;
    const key = `${row.agent}:${row.model}`;
    const existing = groups.get(key);
    if (existing) {
      existing.cost += row.cost_usd;
      existing.calls += 1;
    } else {
      groups.set(key, {
        agent: row.agent,
        model: row.model,
        key,
        cost: row.cost_usd,
        calls: 1,
      });
    }
  }

  if (totalSpend === 0) return [];

  const findings: Array<{ finding: Finding; cost: number }> = [];

  for (const group of groups.values()) {
    const share = group.cost / totalSpend;
    if (share < COST_HOTSPOT_SHARE) continue;

    const severity: Severity = share >= 0.5 ? "high" : "medium";
    const percent = Math.round(share * 100);
    const costFormatted = group.cost.toFixed(2);
    const totalFormatted = totalSpend.toFixed(2);

    findings.push({
      cost: group.cost,
      finding: {
        kind: "cost-hotspot",
        subject: group.key,
        evidence: `${group.key} cost $${costFormatted} of $${totalFormatted} total (${percent}%) across ${group.calls} call${group.calls === 1 ? "" : "s"}.`,
        severity,
      },
    });
  }

  findings.sort((a, b) => b.cost - a.cost);
  return findings.map((f) => f.finding);
}

interface GroupedFailure {
  readonly component: string;
  readonly signatures: Set<string>;
  readonly workers: Set<string>;
}

/**
 * Identify components with >=3 distinct failure signatures.
 * Returns findings sorted by distinct signature count descending.
 */
export function findRecurringFailures(rows: readonly LessonRow[]): Finding[] {
  const groups = new Map<string, GroupedFailure>();

  for (const row of rows) {
    let group = groups.get(row.component);
    if (!group) {
      group = {
        component: row.component,
        signatures: new Set(),
        workers: new Set(),
      };
      groups.set(row.component, group);
    }
    group.signatures.add(row.signature);
    group.workers.add(row.worker);
  }

  const result: Array<{ finding: Finding; count: number }> = [];

  for (const group of groups.values()) {
    const distinctCount = group.signatures.size;
    if (distinctCount < RECURRING_FAILURE_MIN_SIGNATURES) continue;

    const severity: Severity = distinctCount >= 5 ? "high" : "medium";
    const workerList = Array.from(group.workers).sort();
    const workerText = `${workerList.join(", ")} worker${workerList.length === 1 ? "" : "s"}`;

    result.push({
      count: distinctCount,
      finding: {
        kind: "recurring-failure",
        subject: group.component,
        evidence: `${group.component} failed under ${distinctCount} distinct signatures across ${workerText}.`,
        severity,
      },
    });
  }

  result.sort((a, b) => b.count - a.count);
  return result.map((r) => r.finding);
}

/**
 * Identify lessons that have been seen >=3 times but never applied (times_applied === 0).
 * Sorted by times_seen descending — every finding here is high severity, so the
 * order is what tells the reader which broken lesson is costing the most.
 */
export function findUnappliedLessons(rows: readonly LessonRow[]): Finding[] {
  const unapplied = rows
    .filter((row) => row.times_seen >= UNAPPLIED_LESSON_MIN_SEEN && row.times_applied === 0)
    .slice()
    .sort((a, b) => b.times_seen - a.times_seen);

  return unapplied.map((row) => ({
    kind: "unapplied-lesson",
    subject: `${row.worker}:${row.signature}`,
    evidence: `Lesson for ${row.worker}:${row.signature} has been seen ${row.times_seen} times but has never been injected into a retry.`,
    severity: "high",
  }));
}
