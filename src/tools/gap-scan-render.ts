/**
 * FounderOS — AI Visibility Gap Report renderer (spec §3.4)
 * ==========================================================
 * Pure function: GapReportData (+ optional GapInsights) → 1-page Markdown
 * artifact. The structure is fixed by the lead-acquisition spec: header,
 * appearance-rate table, evidence excerpts, diagnosed causes, one stake line,
 * CTA, and the methodology footnote. With insights, the report adds the
 * multi-angle read: intent-funnel table, threat profile, consistency check,
 * and a confidence self-critique (the honesty IS the differentiator — never
 * hide N, completion, or the scan's own limits).
 */

import type { CompanyStats, GapReportData } from "./gap-scan-core.js";
import type { GapInsights } from "./gap-scan-insights.js";

const pct = (n: number): string => `${Math.round(n * 100)}%`;

const INTENT_LABELS: Record<string, string> = {
  alternatives: "Switching intent (“X alternatives”)",
  vs: "Comparison intent (“X vs Y”)",
  best: "Evaluation intent (“best X for Y”)",
  top: "Discovery intent (“top X tools”)",
};

function tableRow(c: CompanyStats, surfaces: string[]): string {
  const cells = surfaces.map((s) => {
    const st = c.per_surface[s];
    return st && st.runs > 0 ? pct(st.rate) : "–";
  });
  const name = c.is_target ? `**${c.name}** (you)` : c.name;
  return `| ${name} | ${pct(c.appearance_rate)} | ${pct(c.cited_rate)} | ${pct(c.first_mention_rate)} | ${cells.join(" | ")} |`;
}

function pushInsightSections(lines: string[], r: GapReportData, ins: GapInsights): void {
  if (ins.intent_breakdown.length > 0) {
    lines.push(`## Where the funnel leaks (by buyer intent)`);
    lines.push("");
    lines.push(`| Intent | Answers | You | Best competitor | Owns this intent |`);
    lines.push(`|---|---|---|---|---|`);
    for (const b of ins.intent_breakdown) {
      lines.push(
        `| ${INTENT_LABELS[b.kind] ?? b.kind} | ${b.runs} | ${pct(b.target_rate)} | ${b.best_competitor} (${pct(b.best_competitor_rate)}) | ${b.owner} |`,
      );
    }
    lines.push("");
  }

  if (ins.threats.length > 0) {
    lines.push(`## Competitor threat profile`);
    lines.push("");
    for (const t of ins.threats) {
      lines.push(
        `- **${t.name}** — ${t.threat.toUpperCase()} threat (index ${t.threat_index}): in ${pct(t.weighted_appearance_rate)} of intent-weighted answers, leads ${pct(t.first_mention_rate)}, cited ${pct(t.cited_rate)}.`,
      );
    }
    lines.push("");
  }

  const { surface_divergence: div, volatility: vol } = ins;
  const consistency: string[] = [];
  if (div.strongest && div.weakest) {
    consistency.push(
      div.divergent
        ? `Visibility splits by engine: ${pct(div.strongest.rate)} on ${div.strongest.surface} vs ${pct(div.weakest.rate)} on ${div.weakest.surface} (spread ${pct(div.spread)}).`
        : `Visibility is consistent across surfaces (spread ${pct(div.spread)}).`,
    );
  }
  if (vol.cells_measured > 0) {
    consistency.push(
      vol.cells_mixed > 0
        ? `Presence flickers on ${vol.cells_mixed} of ${vol.cells_measured} repeated prompts — identical questions include the brand in some runs and drop it in others.`
        : `Presence is stable run-to-run across ${vol.cells_measured} repeated prompts.`,
    );
  }
  if (consistency.length > 0) {
    lines.push(`## Consistency check`);
    lines.push("");
    for (const c of consistency) lines.push(`- ${c}`);
    lines.push("");
  }
}

export function renderGapReport(r: GapReportData, insights?: GapInsights): string {
  const surfaces = r.surfaces;
  const lines: string[] = [];

  lines.push(`# AI Visibility Gap Report — ${r.target.name}`);
  lines.push("");
  lines.push(
    `**Category:** ${r.category} · **Compared against:** ${r.competitors.map((c) => c.name).join(", ")} · **Generated:** ${r.generated_at.slice(0, 10)}`,
  );
  lines.push("");
  lines.push(`## Gap Score: ${r.gap_score}/100`);
  lines.push("");
  lines.push(
    r.gap_score >= 40
      ? `When buyers ask AI assistants about ${r.category}, your competitors are in the answer and ${r.target.name} is not. Share-of-answer rank: ${r.share_of_answer_rank.join(" > ")}.`
      : `Share-of-answer rank across sampled prompts: ${r.share_of_answer_rank.join(" > ")}.`,
  );
  lines.push("");

  lines.push(`## Appearance rates (share of sampled answers naming each company)`);
  lines.push("");
  lines.push(`| Company | Overall | Cited (own domain) | First mention | ${surfaces.join(" | ")} |`);
  lines.push(`|---|---|---|---|${surfaces.map(() => "---").join("|")}|`);
  for (const c of r.companies) lines.push(tableRow(c, surfaces));
  lines.push("");

  if (insights) pushInsightSections(lines, r, insights);

  if (r.evidence.length > 0) {
    lines.push(`## What the answers actually say`);
    lines.push("");
    for (const e of r.evidence) {
      lines.push(`> "${e.excerpt}"`);
      lines.push(`> — ${e.surface}, prompt: "${e.prompt}" (names ${e.competitors_named.join(", ")}; not ${r.target.name})`);
      lines.push("");
    }
  }

  const causes = [...r.causes, ...(insights?.additional_causes ?? [])].slice(0, 5);
  if (causes.length > 0) {
    lines.push(`## Top diagnosed causes`);
    lines.push("");
    causes.forEach((c, i) => {
      lines.push(`${i + 1}. **${c.cause}.** ${c.evidence}`);
    });
    lines.push("");
  }

  lines.push(`## Why it matters`);
  lines.push("");
  if (insights && insights.stake.completed > 0) {
    // Stake measured from THIS scan — never an unsourced market statistic.
    lines.push(
      `In ${insights.stake.lost_answers} of ${insights.stake.completed} sampled buyer questions (${pct(insights.stake.lost_rate)}), an AI assistant recommended a competitor and never mentioned ${r.target.name}. Each of those answers is a buying conversation entered without you.`,
    );
  } else {
    lines.push(
      `Every sampled answer that names a competitor and not ${r.target.name} is a buying conversation entered without you.`,
    );
  }
  lines.push("");
  lines.push(`**Next step:** a 20-minute gap-review call — we walk these runs and the fixes, no slides.`);
  lines.push("");

  if (insights) {
    lines.push(`## Confidence: ${insights.confidence.grade.toUpperCase()}`);
    lines.push("");
    for (const c of insights.confidence.caveats) lines.push(`- ${c}`);
    lines.push("");
  }

  lines.push(`---`);
  lines.push(
    `*Methodology: ${r.prompts.length} buyer-intent prompts × ${surfaces.length} surface(s) (${surfaces.join(", ")}) × ${r.runs_per_prompt} runs = ${r.runs_total} sampled answers (${r.runs_completed} completed, ${pct(r.completion_rate)}). ` +
      `Rates are appearance frequencies, never single answers — AI citations churn 40–60% month over month, which is the case for monitoring, not against it. Generated ${r.generated_at}.*`,
  );
  lines.push("");

  return lines.join("\n");
}
