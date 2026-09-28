/**
 * FounderOS — reply latency from the prod journal
 * ===============================================
 * Usage:
 *   ssh founderos-vps 'sudo -n journalctl -u founderos --since "7 days ago" -o cat' | node --import tsx/esm scripts/latency-report.ts
 *
 * One row per completed turn (start time, total, LLM calls, tool calls, the
 * first 60 characters of the input) and p50/p90/max over the window.
 *
 * WHY THE JOURNAL AND NOT agent_results. `getTurnLatencyPercentiles`
 * (src/db/queries.ts) reads `agent_results.latency_ms`, which only the
 * synthesizer writes — so it never sees a direct reply, a failed turn or a
 * timeout, and those are exactly the slow and the fast ends. The 2026-09-28
 * audit measured "completed turns with both `turn.in` and `turn.out` /
 * `turn.error`" from these trace lines; the before/after for the Gemini
 * thinking change has to use the same definition or it compares two different
 * things.
 *
 * Parsing and per-turn grouping are the log-review funnel's own
 * (`parseLogLines`, `buildTimeline`), so the two readers of this journal cannot
 * disagree about what a line or a turn is.
 */

import { parseLogLines } from "./log-review/sources.js";
import { buildTimeline } from "./log-review/timeline.js";
import type { LogLine } from "./log-review/types.js";

/** Audit baseline, 91 turns over the 30 days to 2026-09-28. */
export const BASELINE = { p50Ms: 18_600, p90Ms: 157_000 } as const;

const INPUT_PREVIEW_CHARS = 60;

export interface TurnLatency {
  readonly turnId: string;
  /** ISO time of the `turn.in` line. */
  readonly startedAt: string;
  /** The trace's own elapsed ms at the last terminal seam. */
  readonly totalMs: number;
  readonly llmCalls: number;
  readonly toolCalls: number;
  /** `error` when any terminal seam was `turn.error`. */
  readonly outcome: "out" | "error";
  readonly input: string;
}

const TERMINAL_SEAMS = new Set(["turn.out", "turn.error"]);

function elapsedMs(line: LogLine): number | undefined {
  const top = line["ms"];
  if (typeof top === "number") return top;
  const nested = line.data?.["ms"];
  return typeof nested === "number" ? nested : undefined;
}

/**
 * Completed turns only: a `turn.in` plus at least one `turn.out`/`turn.error`.
 *
 * A turn paused on an approval card has no terminal seam (it is waiting on a
 * person, not on us), and a resume has no `turn.in` of its own — both are left
 * out, as they were in the audit. A turn that logged `turn.out` and then
 * `turn.error` (the reply was composed, the send failed) is timed to the error:
 * that is when it ended.
 */
export function summarizeTurns(lines: LogLine[]): TurnLatency[] {
  const out: TurnLatency[] = [];
  for (const turn of buildTimeline(lines.filter((l) => typeof l.seam === "string"))) {
    const start = turn.lines.find((l) => l.seam === "turn.in");
    const terminals = turn.lines.filter((l) => TERMINAL_SEAMS.has(l.seam ?? ""));
    if (!start || terminals.length === 0) continue;

    const totals = terminals.map(elapsedMs).filter((ms): ms is number => ms !== undefined);
    if (totals.length === 0) continue;

    const preview = start.data?.["textPreview"];
    out.push({
      turnId: turn.turnId,
      startedAt: new Date(start.time).toISOString(),
      totalMs: Math.max(...totals),
      llmCalls: turn.lines.filter((l) => l.seam === "llm.call").length,
      toolCalls: turn.lines.filter((l) => l.seam === "tool.call").length,
      outcome: terminals.some((l) => l.seam === "turn.error") ? "error" : "out",
      input: typeof preview === "string" ? preview.slice(0, INPUT_PREVIEW_CHARS) : "",
    });
  }
  return out.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

/**
 * Linear interpolation between closest ranks — Postgres `percentile_cont`, the
 * method `getTurnLatencyPercentiles` already uses, so the two numbers mean the
 * same thing. An empty window throws: a percentile of nothing is not 0 ms.
 */
export function percentile(valuesMs: readonly number[], q: number): number {
  if (valuesMs.length === 0) throw new Error("percentile of no turns — nothing was measured");
  const sorted = [...valuesMs].sort((a, b) => a - b);
  const pos = q * (sorted.length - 1);
  const lower = Math.floor(pos);
  const upper = Math.min(lower + 1, sorted.length - 1);
  return sorted[lower]! + (pos - lower) * (sorted[upper]! - sorted[lower]!);
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

export function renderLatencyReport(turns: readonly TurnLatency[]): string {
  if (turns.length === 0) {
    return "No completed turns (turn.in plus turn.out or turn.error) in the input. Widen --since, or check that the journal lines are the raw JSON (-o cat).";
  }
  const rows = turns.map(
    (t) =>
      `${t.startedAt}  ${seconds(t.totalMs).padStart(7)}  llm=${t.llmCalls}  tools=${t.toolCalls}  ` +
      `${t.outcome.padEnd(5)}  ${t.input}`,
  );
  const totals = turns.map((t) => t.totalMs);
  const summary =
    `turns=${turns.length}  p50=${seconds(percentile(totals, 0.5))}  p90=${seconds(percentile(totals, 0.9))}  ` +
    `max=${seconds(Math.max(...totals))}  (baseline p50 ${seconds(BASELINE.p50Ms)}, p90 ${seconds(BASELINE.p90Ms)})`;
  return [...rows, "", summary].join("\n");
}

async function main(): Promise<void> {
  const raw = await new Promise<string>((resolve) => {
    let buf = "";
    process.stdin.on("data", (chunk) => (buf += chunk));
    process.stdin.on("end", () => resolve(buf));
  });
  const turns = summarizeTurns(parseLogLines(raw));
  process.stdout.write(renderLatencyReport(turns) + "\n");
  if (turns.length === 0) process.exitCode = 1;
}

// Run only when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
