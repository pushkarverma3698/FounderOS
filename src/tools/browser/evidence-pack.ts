/**
 * FounderOS — UI Evidence Pack (PURE renderer)
 * ==============================================
 * Rows + verdicts → the markdown a reviewer reads and the JSON a machine reads.
 * No I/O, no clock, no browser: given the same inputs this returns the same
 * bytes, so it is fixture-testable and its output can be diffed across runs.
 *
 * ## Why a pack instead of a prompt instruction
 *
 * `pr-brain` could be told "use vision on this PR". It would decay: CLAUDE.md
 * rule #27 measured CI-enforced rules drifting zero times in a month against
 * markdown rules drifting three times in a day. A rendered artifact posted on
 * the PR is evidence the reviewer reads, not an instruction it may skip.
 *
 * ## The skipped-stage rule
 *
 * A vision stage that did not run is printed as SKIPPED, with the reason, and
 * the pack says plainly that visual defects were not checked. It is never
 * rendered as a clean pass. src/evolution/run-audit.ts carries the same rule for
 * its telemetry tier, and for the same reason: prod once showed a tier that
 * never ran as a tier that came back clean.
 */

import type { UiCheckRow, UiDefect, UiSeverity } from "./ui-analyze.js";
import type { UiVerdict } from "./ui-vision.js";

export interface VisionStage {
  /** false when vision did not run at all. */
  readonly ran: boolean;
  /** Required whenever `ran` is false. Printed verbatim. */
  readonly skippedReason?: string;
  readonly verdicts?: readonly UiVerdict[];
  /** Per-image failures that did not stop the run (transport, parse). */
  readonly errors?: readonly { target: string; viewport: string; error: string }[];
}

export interface EvidencePack {
  readonly markdown: string;
  readonly json: string;
  readonly highSeverityCount: number;
  readonly pass: boolean;
}

const SEVERITY_ICON: Record<UiSeverity, string> = {
  high: "🔴",
  medium: "🟡",
  low: "⚪",
};

const SEVERITY_RANK: Record<UiSeverity, number> = { high: 0, medium: 1, low: 2 };

function sortedDefects(defects: readonly UiDefect[]): UiDefect[] {
  return [...defects].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

/** Every reason gets its own bullet with its own result — never a collapsed summary. */
function renderRow(row: UiCheckRow): string[] {
  const lines: string[] = [];
  const status = row.ok ? "✅ PASS" : "❌ FAIL";
  lines.push(`### ${status} — \`${row.target}\` @ ${row.viewport}`);
  lines.push("");
  lines.push(`Page: \`${row.url}\``);
  if (row.screenshotPath) lines.push(`Screenshot: \`${row.screenshotPath}\``);
  lines.push("");

  if (row.defects.length === 0) {
    lines.push("- ✅ No measurable defects: the page rendered, its assets loaded, no placeholders were left unfilled, and it fits its viewport.");
    lines.push("");
    return lines;
  }

  for (const d of sortedDefects(row.defects)) {
    lines.push(`- ${SEVERITY_ICON[d.severity]} **${d.kind}** — ${d.detail}`);
  }
  lines.push("");
  return lines;
}

function renderVisionStage(stage: VisionStage): string[] {
  const lines: string[] = ["## Visual review (vision)", ""];

  if (!stage.ran) {
    lines.push(
      `- ⏭️ **SKIPPED** — ${stage.skippedReason ?? "no reason given"}.`,
      "- ⚠️ Visual defects (overlapping text, unreadable contrast, broken layout) were **NOT** checked on this run. A pass above covers measurable defects only.",
      "",
    );
    return lines;
  }

  const verdicts = stage.verdicts ?? [];
  const errors = stage.errors ?? [];

  if (verdicts.length === 0 && errors.length === 0) {
    lines.push("- ⏭️ Vision ran but produced no verdicts (no screenshots were supplied).", "");
    return lines;
  }

  for (const v of verdicts) {
    const status = v.ok ? "✅ PASS" : "❌ FAIL";
    // "Visual:" is load-bearing. Without it this heading is byte-identical to the
    // measured section's, and a reader scrolling a red pack cannot tell which
    // stage failed. Measured 2026-09-22 on run 35786606697: eight measured rows
    // all reading "No measurable defects" sat directly above six `### ❌ FAIL`
    // headings, which is indistinguishable from a report contradicting itself.
    lines.push(`### ${status} — Visual: \`${v.target}\` @ ${v.viewport}`, "");
    if (!v.readable) {
      lines.push(`- 🔴 **unreadable-screenshot** — ${v.summary || "The screenshot was blank or unreadable, so nothing could be judged."}`, "");
      continue;
    }
    lines.push(`- ${v.summary}`);
    for (const d of [...v.defects].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])) {
      lines.push(`- ${SEVERITY_ICON[d.severity]} **${d.area}** — ${d.description}`);
    }
    lines.push("");
  }

  for (const e of errors) {
    lines.push(`- ⚠️ \`${e.target}\` @ ${e.viewport}: vision did not return a verdict — ${e.error}`, "");
  }

  return lines;
}

/** Vision high-severity defects count toward the gate only when vision actually ran. */
function visionHighCount(stage: VisionStage): number {
  if (!stage.ran) return 0;
  return (stage.verdicts ?? []).reduce(
    (n, v) => n + (v.readable ? v.defects.filter((d) => d.severity === "high").length : 1),
    0,
  );
}

/**
 * Render the pack.
 *
 * `pass` is the gate's verdict: no high-severity measured defect, and no
 * high-severity visual defect when vision ran. A skipped vision stage does not
 * fail the build — it is reported loudly instead, because failing every PR on a
 * missing API key would train everyone to ignore the check.
 */
export function renderEvidencePack(
  rows: readonly UiCheckRow[],
  stage: VisionStage,
  // Named so the footer cannot claim the wrong producer. `qa:app` renders the
  // same pack from a booted application rather than from static scaffolds, and a
  // report that tells the reader to run `pnpm qa:ui` to reproduce it would send
  // them to a command that checks something else entirely.
  opts: { generator?: string; reference?: string } = {},
): EvidencePack {
  const generator = opts.generator ?? "pnpm qa:ui";
  const reference = opts.reference ?? "docs/antigravity/UI-QA-CONTRACT.md";
  const measuredHigh = rows.flatMap((r) => r.defects).filter((d) => d.severity === "high").length;
  const visualHigh = visionHighCount(stage);
  const highSeverityCount = measuredHigh + visualHigh;
  const pass = highSeverityCount === 0;

  const failingRows = rows.filter((r) => !r.ok).length;
  // The two stages are counted SEPARATELY in the headline.
  //
  // They were not, and the result was a summary whose arithmetic disagreed with
  // its own rows: "5 blocking defect(s) across 0 of 8 page/viewport
  // combination(s)" — five defects spread over zero rows — printed above eight
  // rows each reading "No measurable defects". Every blocker was visual, and the
  // sentence had no word for that. A report that contradicts itself is the
  // "fabricated evidence" shape the review protocol tells a gate to hunt for;
  // producing one is worse than producing none.
  const measuredClause =
    measuredHigh > 0
      ? `${measuredHigh} measured, across ${failingRows} of ${rows.length} page/viewport combination(s)`
      : `0 measured (all ${rows.length} page/viewport combination(s) rendered clean)`;
  const visualClause = visualHigh > 0 ? `, ${visualHigh} visual` : "";

  const lines: string[] = [
    "## UI Evidence Pack",
    "",
    pass
      ? `✅ **PASS** — ${rows.length} page/viewport combination(s) checked, no blocking defects.`
      : `❌ **FAIL** — ${highSeverityCount} blocking defect(s): ${measuredClause}${visualClause}.`,
    "",
    "| Page | Viewport | Result | Defects |",
    "|---|---|---|---|",
    ...rows.map(
      (r) =>
        `| \`${r.target}\` | ${r.viewport} | ${r.ok ? "✅ pass" : "❌ fail"} | ${r.defects.length} |`,
    ),
    "",
    "## Measured checks (deterministic, no AI call)",
    "",
    ...rows.flatMap(renderRow),
    ...renderVisionStage(stage),
    "---",
    `_Generated by \`${generator}\` — see \`${reference}\`._`,
  ];

  const json = JSON.stringify(
    {
      pass,
      high_severity_count: highSeverityCount,
      measured_high: measuredHigh,
      visual_high: visualHigh,
      vision: stage.ran
        ? { ran: true, verdicts: stage.verdicts ?? [], errors: stage.errors ?? [] }
        : { ran: false, skipped_reason: stage.skippedReason ?? "no reason given" },
      rows,
    },
    null,
    2,
  );

  return { markdown: lines.join("\n"), json, highSeverityCount, pass };
}
