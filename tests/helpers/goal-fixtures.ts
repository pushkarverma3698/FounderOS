/**
 * Fixtures for the goals unit tests: a goal row with sane defaults, and metric sources that record
 * how they were called.
 */

import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import type { MetricDeps } from "../../src/goals/metrics.js";
import type { GoalRow } from "../../src/goals/types.js";

export const TZ = "Europe/Amsterdam";
/** 09:00 Amsterdam (CEST) on 2026-09-29, the moment the cron fires. */
export const NINE_AM = new Date("2026-09-29T07:00:00.000Z");

export function makeGoal(over: Partial<GoalRow> = {}): GoalRow {
  const created = new Date("2026-09-01T08:00:00.000Z");
  return {
    id: randomUUID(),
    tenant_id: "t",
    title: "A goal",
    metric_key: "manual",
    metric_arg: null,
    target: 5,
    baseline: 0,
    due_on: null,
    status: "active",
    blocked_until: null,
    blocker: null,
    priority: 100,
    manual_value: null,
    manual_value_at: null,
    created_at: created,
    updated_at: created,
    ...over,
  };
}

export type SpyDeps = { [K in keyof MetricDeps]: ReturnType<typeof vi.fn> } & MetricDeps;

/** Metric sources that answer 0 unless told otherwise, and remember every call. */
export function makeMetricDeps(over: Partial<MetricDeps> = {}): SpyDeps {
  return {
    countApplications: vi.fn(async () => 0),
    countActions: vi.fn(async () => 0),
    countMergedPrs: vi.fn(async () => 0),
    countClosedIssues: vi.fn(async () => 0),
    ...over,
  } as SpyDeps;
}
