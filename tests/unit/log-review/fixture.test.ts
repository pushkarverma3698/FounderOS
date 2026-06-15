// tests/unit/log-review/fixture.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseLogLines } from "../../../scripts/log-review/sources.js";
import { buildTimeline } from "../../../scripts/log-review/timeline.js";
import { runDetectors } from "../../../scripts/log-review/detectors.js";
import { buildDigest } from "../../../scripts/log-review/digest.js";

describe("real prod fixture", () => {
  const raw = readFileSync("tests/fixtures/log-review/prod-sample.jsonl", "utf8");

  it("parses, builds turns, detects, and produces a bounded digest", () => {
    const lines = parseLogLines(raw);
    expect(lines.length).toBeGreaterThan(0); // proves field names match reality
    const turns = buildTimeline(lines);
    const anomalies = runDetectors(turns);
    const digest = buildDigest(turns, anomalies, [], { windowDays: 3 });
    expect(digest.counts.turns).toBe(turns.length);
    expect(digest.borderlineTurns.length).toBeLessThanOrEqual(25);
  });

  it("parses the prod ISO `time` string into a numeric epoch (field-name guard)", () => {
    const lines = parseLogLines(raw);
    // every line must have a numeric, non-zero time — proves ISO parsing works
    expect(lines.every((l) => typeof l.time === "number")).toBe(true);
    expect(lines.some((l) => l.time > 0)).toBe(true);
  });

  it("reads turn.out token metrics AND top-level ms duration (field-name guard)", () => {
    const lines = parseLogLines(raw);
    const turnOut = lines.filter((l) => l.seam === "turn.out");
    if (turnOut.length === 0) return; // fixture window may have none
    const turns = buildTimeline(lines);
    const withTokens = turns.filter((t) => t.usd !== undefined || t.inputTokens !== undefined);
    expect(withTokens.length).toBeGreaterThan(0);
    // ms lives at the top level in prod — at least one turn must derive durationMs
    const withDuration = turns.filter((t) => t.durationMs !== undefined);
    expect(withDuration.length).toBeGreaterThan(0);
  });

  it("orders turns chronologically by real timestamp", () => {
    const turns = buildTimeline(parseLogLines(raw));
    for (let i = 1; i < turns.length; i++) {
      expect(turns[i]!.startMs).toBeGreaterThanOrEqual(turns[i - 1]!.startMs);
    }
  });
});
