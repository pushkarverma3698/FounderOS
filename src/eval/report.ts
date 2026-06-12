/**
 * FounderOS — Eval Report Renderer (pure)
 * ========================================
 * Turns an EvalReport into the EVAL.md a hiring manager (or buyer) reads in
 * <30 seconds: a metrics summary table, an explicit failures list, and a full
 * per-task table. Pure string generation — no I/O.
 */

import type { EvalReport, TaskResult, MetricSummary } from "./types.js";

/** Round an accuracy in [0,1] to a whole-percent string. */
function pct(accuracy: number): string {
  return `${Math.round(accuracy * 100)}%`;
}

function metricRow(label: string, m: MetricSummary, bold = false): string {
  const wrap = (s: string) => (bold ? `**${s}**` : s);
  return `| ${wrap(label)} | ${wrap(String(m.passed))} | ${wrap(String(m.total))} | ${wrap(pct(m.accuracy))} |`;
}

/** Human-readable list of which checks failed for one task. */
function describeFailure(r: TaskResult): string {
  const lines: string[] = [];
  if (!r.routeCorrect) {
    lines.push(`route: expected \`${r.task.expectedRoute}\`, got \`${r.observation.route ?? "none"}\``);
  }
  if (!r.toolsCorrect) {
    const want = (r.task.expectedTools ?? []).join(", ") || "none";
    const got = r.observation.tools.join(", ") || "none";
    lines.push(`tools: expected [${want}], got [${got}]`);
  }
  if (!r.hitlCorrect) {
    lines.push(`hitl: expected \`${r.task.expectsHitl}\`, got \`${r.observation.hadInterrupt}\``);
  }
  if (r.observation.error) {
    lines.push(`error: ${r.observation.error}`);
  }
  return lines.map((l) => `  - ${l}`).join("\n");
}

/** Cell helper: tick/cross, or an em-dash when the check did not apply. */
function applies(applicable: boolean, ok: boolean): string {
  if (!applicable) return "–";
  return ok ? "✅" : "❌";
}

/** Render the full EVAL.md markdown for a report. */
export function renderReport(report: EvalReport): string {
  const failures = report.results.filter((r) => !r.passed);

  const summary = [
    "## Summary",
    "",
    "| Metric | Passed | Total | Accuracy |",
    "|---|---|---|---|",
    metricRow("Routing accuracy", report.routing),
    metricRow("Tool selection", report.toolSelection),
    metricRow("HITL coverage", report.hitlCoverage),
    metricRow("Overall", report.overall, true),
    ...(report.infraErrors > 0
      ? [
          "",
          `> ⚠️ **${report.infraErrors} task(s) excluded as infrastructure errors** (transient ` +
            `503/timeout that escaped the model layer) — these are NOT scored as routing/tool ` +
            `misses, so the capability numbers above reflect runs where infra was healthy.`,
        ]
      : []),
  ].join("\n");

  const failureSection = [
    `## Failures (${failures.length})`,
    "",
    failures.length === 0
      ? "All golden tasks passed. ✅"
      : failures
          .map((r) => `- **${r.task.id}** — \`${r.task.input}\`\n${describeFailure(r)}`)
          .join("\n"),
  ].join("\n");

  const tableRows = report.results.map((r) => {
    const toolsApplicable = (r.task.expectedTools?.length ?? 0) > 0;
    const hitlApplicable = r.task.expectsHitl !== undefined;
    return `| ${r.task.id} | ${r.task.input} | ${applies(true, r.routeCorrect)} ${r.observation.route ?? "none"} | ${applies(toolsApplicable, r.toolsCorrect)} | ${applies(hitlApplicable, r.hitlCorrect)} | ${r.passed ? "✅" : "❌"} |`;
  });

  const allTasks = [
    `## All tasks (${report.results.length})`,
    "",
    "| id | input | route | tools | hitl | result |",
    "|---|---|---|---|---|---|",
    ...tableRows,
  ].join("\n");

  return [
    "# FounderOS — Agent Eval Report",
    "",
    `_Generated: ${report.generatedAt}_`,
    "",
    "An evaluation of the FounderOS multi-agent system against a fixed golden-task set, run at",
    "temperature 0 for reproducibility. Note: Gemini is not bit-for-bit deterministic even at",
    "temperature 0, so individual task results on genuinely ambiguous routes can vary slightly",
    "between runs — treat a single number as a point estimate, not a guarantee.",
    "Each task scores routing (did the supervisor pick the right department?), tool selection (did it",
    "use the expected tools?), and HITL coverage (did write actions pause for approval when required?).",
    "",
    summary,
    "",
    failureSection,
    "",
    allTasks,
    "",
  ].join("\n");
}
