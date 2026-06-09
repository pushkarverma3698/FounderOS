/**
 * Reads EVAL.md scores and updates the metrics table in README.md.
 * Run after `pnpm eval` to keep README in sync with real eval results.
 * Idempotent — safe to run multiple times.
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dirname, "..");
const EVAL_PATH = join(ROOT, "EVAL.md");
const README_PATH = join(ROOT, "README.md");

interface Metrics {
  routing: string;
  toolSelection: string;
  hitl: string;
  overall: string;
  date: string;
}

function parseEvalMd(content: string): Metrics {
  const date = new Date().toISOString().slice(0, 10);

  // Match lines like: | Routing accuracy | 12/24 — 50% |
  const routingMatch = content.match(/routing accuracy[^|]*\|([^|]+)\|/i);
  const toolMatch = content.match(/tool.?selection[^|]*\|([^|]+)\|/i);
  const hitlMatch = content.match(/hitl.?coverage[^|]*\|([^|]+)\|/i);
  const overallMatch = content.match(/overall[^|]*\|([^|]+)\|/i);

  const extract = (match: RegExpMatchArray | null, fallback: string): string =>
    match ? match[1].trim() : fallback;

  return {
    routing: extract(routingMatch, "N/A"),
    toolSelection: extract(toolMatch, "N/A"),
    hitl: extract(hitlMatch, "N/A"),
    overall: extract(overallMatch, "N/A"),
    date,
  };
}

function buildMetricsTable(m: Metrics): string {
  return `| Routing accuracy | ${m.routing} | ${m.date} |
| Tool selection | ${m.toolSelection} | ${m.date} |
| HITL coverage | ${m.hitl} | ${m.date} |
| **Overall** | **${m.overall}** | ${m.date} |`;
}

function updateReadme(readme: string, table: string): string {
  // Replace everything between the metrics table header and the next blank line after the table
  const headerPattern =
    /(\|\s*Metric\s*\|[^\n]*\n\|[-| ]+\|\n)(\| Routing accuracy[^]*?\| \*\*Overall\*\*[^\n]*\n)/;

  if (headerPattern.test(readme)) {
    return readme.replace(headerPattern, `$1${table}\n`);
  }

  // Fallback: if the table header isn't found, append metrics section
  console.warn(
    "⚠️  README metrics table not found — appending. Check table format.",
  );
  return readme + `\n\n## Eval Metrics\n\n| Metric | Score | Date |\n|--------|-------|------|\n${table}\n`;
}

// ── Main ─────────────────────────────────────────────────────────────────────

let evalContent: string;
try {
  evalContent = readFileSync(EVAL_PATH, "utf-8");
} catch {
  console.error(`❌  EVAL.md not found at ${EVAL_PATH}. Run 'pnpm eval' first.`);
  process.exit(1);
}

const metrics = parseEvalMd(evalContent);
console.log("Parsed metrics:", metrics);

const readme = readFileSync(README_PATH, "utf-8");
const updatedReadme = updateReadme(readme, buildMetricsTable(metrics));

if (updatedReadme === readme) {
  console.log("✅  README metrics already up-to-date.");
} else {
  writeFileSync(README_PATH, updatedReadme, "utf-8");
  console.log(`✅  README.md updated with metrics from ${metrics.date}.`);
}
