/**
 * AG-008 — turn latency percentiles.
 *
 * `summarizeTurnLatency` is the pure half of `getTurnLatencyPercentiles`: the SQL
 * fetches, this interprets. Splitting them is what lets the invariant be tested with
 * an object literal and no database.
 *
 * The invariant under test is the rag-optimization-sweep one: a P95 computed over 3
 * of 400 rows must NOT be indistinguishable from one computed over all 400, and a
 * window that measured nothing must NOT render as a percentile of zero.
 */

import { describe, it, expect } from "vitest";
import {
  summarizeTurnLatency,
  LATENCY_P50,
  LATENCY_P95,
  LATENCY_P99,
  type TurnLatencyAggregateRow,
} from "../../../src/db/queries.js";

const DAYS = 7;

describe("summarizeTurnLatency — real data", () => {
  it("reports percentiles and full coverage when every row is measured", () => {
    // Arrange
    const row: TurnLatencyAggregateRow = {
      total_rows: "400",
      measured_rows: "400",
      p50_ms: "1200",
      p95_ms: "8400",
      p99_ms: "15000",
    };

    // Act
    const result = summarizeTurnLatency(row, DAYS);

    // Assert
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.percentiles.p50Ms).toBe(1200);
    expect(result.percentiles.p95Ms).toBe(8400);
    expect(result.percentiles.p99Ms).toBe(15000);
    expect(result.percentiles.measuredRows).toBe(400);
    expect(result.percentiles.excludedRows).toBe(0);
    expect(result.percentiles.coveragePercent).toBe(100);
  });

  it("reports the excluded count so a thin sample cannot pass as a full one", () => {
    // Arrange — same percentiles, 3 of 400 rows measured
    const thin: TurnLatencyAggregateRow = {
      total_rows: "400",
      measured_rows: "3",
      p50_ms: "1200",
      p95_ms: "8400",
      p99_ms: "15000",
    };
    const full: TurnLatencyAggregateRow = { ...thin, measured_rows: "400" };

    // Act
    const thinResult = summarizeTurnLatency(thin, DAYS);
    const fullResult = summarizeTurnLatency(full, DAYS);

    // Assert — identical percentiles, and yet the two results are distinguishable
    expect(thinResult.ok && fullResult.ok).toBe(true);
    if (!thinResult.ok || !fullResult.ok) return;
    expect(thinResult.percentiles.p95Ms).toBe(fullResult.percentiles.p95Ms);
    expect(thinResult.percentiles.excludedRows).toBe(397);
    expect(fullResult.percentiles.excludedRows).toBe(0);
    expect(thinResult.percentiles.coveragePercent).toBe(0.8);
    expect(thinResult.percentiles.summary).not.toBe(fullResult.percentiles.summary);
  });

  it("prints a founder-legible sentence carrying the real numbers", () => {
    const result = summarizeTurnLatency(
      { total_rows: 400, measured_rows: 3, p50_ms: 1200, p95_ms: 8400, p99_ms: 15000 },
      DAYS,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.percentiles.summary).toContain("P95 8400ms");
    expect(result.percentiles.summary).toContain("3 of 400 recorded turns");
    expect(result.percentiles.summary).toContain("397 excluded");
  });

  it("accepts numeric cells as well as the strings pg returns for int8", () => {
    const asNumbers = summarizeTurnLatency(
      { total_rows: 10, measured_rows: 10, p50_ms: 100, p95_ms: 200, p99_ms: 300 },
      DAYS,
    );
    const asStrings = summarizeTurnLatency(
      { total_rows: "10", measured_rows: "10", p50_ms: "100", p95_ms: "200", p99_ms: "300" },
      DAYS,
    );
    expect(asNumbers).toEqual(asStrings);
  });
});

describe("summarizeTurnLatency — nothing to measure", () => {
  it("does NOT report a percentile of zero when no turns were recorded", () => {
    const result = summarizeTurnLatency(
      { total_rows: "0", measured_rows: "0", p50_ms: null, p95_ms: null, p99_ms: null },
      DAYS,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("No turns were recorded at all");
  });

  it("distinguishes 'rows exist but none is measured' from 'no rows at all'", () => {
    const unmeasured = summarizeTurnLatency(
      { total_rows: "400", measured_rows: "0", p50_ms: null, p95_ms: null, p99_ms: null },
      DAYS,
    );
    const empty = summarizeTurnLatency(
      { total_rows: "0", measured_rows: "0", p50_ms: null, p95_ms: null, p99_ms: null },
      DAYS,
    );
    expect(unmeasured.ok).toBe(false);
    expect(empty.ok).toBe(false);
    if (unmeasured.ok || empty.ok) return;
    expect(unmeasured.reason).toContain("400 turns were recorded");
    expect(unmeasured.reason).not.toBe(empty.reason);
  });

  it("refuses to report when the aggregate row is missing entirely", () => {
    const result = summarizeTurnLatency(undefined, DAYS);
    expect(result.ok).toBe(false);
  });

  it("refuses to report a NaN percentile rather than passing it downstream", () => {
    const result = summarizeTurnLatency(
      { total_rows: "10", measured_rows: "10", p50_ms: "not-a-number", p95_ms: "200", p99_ms: "300" },
      DAYS,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("non-numeric percentile");
  });

  it("refuses to report when the counts themselves are unreadable", () => {
    const result = summarizeTurnLatency(
      { total_rows: null, measured_rows: null, p50_ms: "1", p95_ms: "2", p99_ms: "3" },
      DAYS,
    );
    expect(result.ok).toBe(false);
  });

  it("phrases a single-day window in the singular", () => {
    const result = summarizeTurnLatency(
      { total_rows: "0", measured_rows: "0", p50_ms: null, p95_ms: null, p99_ms: null },
      1,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("in the last 1 day,");
  });
});

describe("percentile constants", () => {
  it("pins the fractions the SQL asks percentile_cont for", () => {
    expect(LATENCY_P50).toBe(0.5);
    expect(LATENCY_P95).toBe(0.95);
    expect(LATENCY_P99).toBe(0.99);
  });
});
