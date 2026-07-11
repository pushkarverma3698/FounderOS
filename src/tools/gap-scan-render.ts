/**
 * FounderOS — AI Visibility Gap Report renderer (spec §3.4)
 * ==========================================================
 * Pure function: GapReportData → 1-page Markdown artifact. The structure is
 * fixed by the lead-acquisition spec: header, appearance-rate table, evidence
 * excerpts, top-3 diagnosed causes, one stake line, CTA, and the methodology
 * footnote (the honesty IS the differentiator — never hide N or completion).
 */

import type { CompanyStats, GapReportData } from "./gap-scan-core.js";

const pct = (n: number): string => `${Math.round(n * 100)}%`;

function tableRow(c: CompanyStats, surfaces: string[]): string {
  const cells = surfaces.map((s) => {
    const st = c.per_surface[s];
    return st && st.runs > 0 ? pct(st.rate) : "–";
  });
  const name = c.is_target ? `**${c.name}** (you)` : c.name;
  return `| ${name} | ${pct(c.appearance_rate)} | ${pct(c.cited_rate)} | ${pct(c.first_mention_rate)} | ${cells.join(" | ")} |`;
}

export function renderGapReport(r: GapReportData): string {
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

  if (r.evidence.length > 0) {
    lines.push(`## What the answers actually say`);
    lines.push("");
    for (const e of r.evidence) {
      lines.push(`> "${e.excerpt}"`);
      lines.push(`> — ${e.surface}, prompt: "${e.prompt}" (names ${e.competitors_named.join(", ")}; not ${r.target.name})`);
      lines.push("");
    }
  }

  if (r.causes.length > 0) {
    lines.push(`## Top diagnosed causes`);
    lines.push("");
    r.causes.forEach((c, i) => {
      lines.push(`${i + 1}. **${c.cause}.** ${c.evidence}`);
    });
    lines.push("");
  }

  lines.push(`## Why it matters`);
  lines.push("");
  lines.push(
    `AI-referred visitors convert at roughly 4x organic in category data — this is the highest-intent channel ${r.target.name} is currently absent from.`,
  );
  lines.push("");
  lines.push(`**Next step:** a 20-minute gap-review call — we walk these runs and the three fixes, no slides.`);
  lines.push("");
  lines.push(`---`);
  lines.push(
    `*Methodology: ${r.prompts.length} buyer-intent prompts × ${surfaces.length} surface(s) (${surfaces.join(", ")}) × ${r.runs_per_prompt} runs = ${r.runs_total} sampled answers (${r.runs_completed} completed, ${pct(r.completion_rate)}). ` +
      `Rates are appearance frequencies, never single answers — AI citations churn 40–60% month over month, which is the case for monitoring, not against it. Generated ${r.generated_at}.*`,
  );
  lines.push("");

  return lines.join("\n");
}
