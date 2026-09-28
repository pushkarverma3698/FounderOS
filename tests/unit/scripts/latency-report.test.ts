/**
 * scripts/latency-report.ts — reply latency, measured the way the audit measured it.
 *
 * The 2026-09-28 audit (docs/plans/2026-09-28-perf-ux-rag-audit.md §1) put the
 * baseline at p50 18.6 s / p90 157 s over "completed turns with both `turn.in`
 * and `turn.out`/`turn.error`" in the `"module":"trace"` journal lines. The
 * Gemini thinking change is judged against that number, so the report must use
 * the same definition or the before/after is two different measurements.
 *
 * The fixture lines copy the prod shape: pino JSON, ISO `time`, and `ms` at the
 * TOP LEVEL of the line (not inside `data` — see log-review/timeline.ts).
 */

import { describe, it, expect } from "vitest";
import { parseLogLines } from "../../../scripts/log-review/sources.js";
import {
  percentile,
  renderLatencyReport,
  summarizeTurns,
} from "../../../scripts/latency-report.js";

/** One prod-shaped trace line. */
function trace(turnId: string, seam: string, ms: number, data?: Record<string, unknown>, level = 30): string {
  const time = new Date(Date.parse("2026-09-21T09:14:02.000Z") + ms).toISOString();
  return JSON.stringify({
    level,
    time,
    app: "founderos",
    env: "production",
    module: "trace",
    turnId,
    seam,
    ms,
    chatId: "1001",
    kind: "message",
    ...(data ? { data } : {}),
    msg: `trace ${seam}`,
  });
}

const FIXTURE = [
  "-- Boot 3f2a… --", // journald banner: not JSON, skipped
  // "list my 3 most recent emails" (09-21): planner, two worker hops, one tool, synthesizer.
  trace("email", "turn.in", 0, { textPreview: "list my 3 most recent emails" }),
  trace("email", "llm.call", 4, { model: "planner" }),
  trace("email", "llm.call", 3_600, { model: "worker" }),
  trace("email", "tool.call", 5_600, { tool: "read_emails", input: "{}" }),
  trace("email", "tool.result", 5_900, { preview: "3 emails" }),
  trace("email", "llm.call", 5_910, { model: "worker" }),
  trace("email", "llm.call", 8_200, { model: "synthesizer" }),
  trace("email", "turn.out", 11_600, { replyPreview: "Here are your 3 most recent emails…" }),
  // A direct reply: one planner call, no tools.
  trace("caps", "turn.in", 0, { textPreview: "What engineering capabilities you have? Tell me everything in detail please" }),
  trace("caps", "llm.call", 3, { model: "planner" }),
  trace("caps", "turn.out", 7_000, { replyPreview: "I can…" }),
  // A turn that errored after the reply was composed: both terminal seams.
  trace("jev", "turn.in", 0, { textPreview: "Is Jev useful for us?" }),
  trace("jev", "llm.call", 2, { model: "planner" }),
  trace("jev", "tool.call", 7_100, { tool: "search_web", input: "Jev" }),
  trace("jev", "turn.out", 84_100, { replyPreview: "Jev is…" }),
  trace("jev", "turn.error", 84_150, { message: "Telegram 400" }, 50),
  // Paused on an approval card: no terminal seam, so not a completed turn.
  trace("hitl", "turn.in", 0, { textPreview: "email the landlord" }),
  trace("hitl", "llm.call", 2, { model: "planner" }),
  trace("hitl", "hitl.interrupt", 9_000, { title: "Send email" }),
  // A resume turn has no turn.in of its own: excluded, like the audit.
  trace("resume", "hitl.resume", 0, { decision: "approved" }),
  trace("resume", "turn.out", 3_000, { replyPreview: "Sent." }),
  // A non-trace line that happens to carry a turnId must not count as a call.
  JSON.stringify({ level: 30, time: "2026-09-21T09:14:03.000Z", module: "kernel-run", turnId: "email", msg: "misc" }),
].join("\n");

describe("summarizeTurns — the audit's definition of a completed turn", () => {
  const turns = summarizeTurns(parseLogLines(FIXTURE));

  it("keeps only turns with turn.in plus turn.out or turn.error", () => {
    expect(turns.map((t) => t.turnId).sort()).toEqual(["caps", "email", "jev"]);
  });

  it("counts llm.call and tool.call seams per turn, not other log lines", () => {
    const email = turns.find((t) => t.turnId === "email");
    expect(email?.llmCalls).toBe(4);
    expect(email?.toolCalls).toBe(1);
    expect(turns.find((t) => t.turnId === "caps")?.toolCalls).toBe(0);
  });

  it("takes the total from the trace's own elapsed ms, using the last terminal seam", () => {
    expect(turns.find((t) => t.turnId === "email")?.totalMs).toBe(11_600);
    expect(turns.find((t) => t.turnId === "jev")?.totalMs).toBe(84_150);
    expect(turns.find((t) => t.turnId === "jev")?.outcome).toBe("error");
    expect(turns.find((t) => t.turnId === "email")?.outcome).toBe("out");
  });

  it("carries the first 60 characters of the input", () => {
    const caps = turns.find((t) => t.turnId === "caps");
    expect(caps?.input).toBe("What engineering capabilities you have? Tell me everything i");
    expect(caps?.input.length).toBe(60);
  });
});

describe("percentile — linear interpolation, the same method as percentile_cont", () => {
  it("interpolates between neighbours", () => {
    expect(percentile([1_000, 2_000, 3_000, 4_000], 0.5)).toBe(2_500);
    expect(percentile([1_000, 2_000, 3_000, 4_000], 0.9)).toBeCloseTo(3_700, 6);
  });

  it("returns the single value for a one-turn window", () => {
    expect(percentile([7_000], 0.9)).toBe(7_000);
  });

  it("refuses an empty window instead of reporting 0 ms", () => {
    expect(() => percentile([], 0.5)).toThrow(/no turns/i);
  });
});

describe("renderLatencyReport", () => {
  it("prints one row per turn and p50/p90/max against the audit baseline", () => {
    const report = renderLatencyReport(summarizeTurns(parseLogLines(FIXTURE)));
    expect(report).toContain("list my 3 most recent emails");
    expect(report).toContain("11.6s");
    expect(report).toMatch(/turns=3/);
    expect(report).toMatch(/p50=11\.6s/);
    expect(report).toMatch(/max=84\.2s/);
    expect(report).toContain("baseline p50 18.6s, p90 157.0s");
  });

  it("says plainly when the window holds no completed turn", () => {
    expect(renderLatencyReport([])).toMatch(/no completed turns/i);
  });
});
