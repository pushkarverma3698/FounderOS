// tests/unit/log-review/timeline.test.ts
import { describe, it, expect } from "vitest";
import { buildTimeline } from "../../../scripts/log-review/timeline.js";
import type { LogLine } from "../../../scripts/log-review/types.js";

const line = (o: Partial<LogLine>): LogLine => ({
  level: 30,
  time: 0,
  raw: JSON.stringify(o),
  ...o,
});

describe("buildTimeline", () => {
  it("groups lines by turnId and orders by start time", () => {
    const lines: LogLine[] = [
      line({ turnId: "B", time: 200, seam: "turn.in" }),
      line({ turnId: "A", time: 100, seam: "turn.in" }),
      line({ turnId: "A", time: 150, seam: "turn.out", data: { usd: 0.01, ms: 500 } }),
    ];
    const turns = buildTimeline(lines);
    expect(turns.map((t) => t.turnId)).toEqual(["A", "B"]);
    expect(turns[0]!.usd).toBe(0.01);
    expect(turns[0]!.durationMs).toBe(500);
  });

  it("derives token + tool-error facts from turn.out", () => {
    const turns = buildTimeline([
      line({
        turnId: "A",
        time: 1,
        seam: "turn.out",
        data: { inputTokens: 1200, outputTokens: 300, usd: 0.02, toolErrors: 2 },
      }),
    ]);
    expect(turns[0]!.inputTokens).toBe(1200);
    expect(turns[0]!.outputTokens).toBe(300);
    expect(turns[0]!.toolErrors).toBe(2);
  });

  it("flags hadError when any line is level>=50", () => {
    const turns = buildTimeline([
      line({ turnId: "A", time: 1, level: 50, msg: "boom" }),
    ]);
    expect(turns[0]!.hadError).toBe(true);
  });

  it("drops lines with no turnId into no synthetic turn", () => {
    const turns = buildTimeline([line({ time: 1, level: 50, msg: "orphan" })]);
    expect(turns).toEqual([]);
  });
});
