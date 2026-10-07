/**
 * Numbers for the AG-031 model A/B table, computed from an EvalReport (pure).
 *
 *   pass %   over scored tasks; infra errors are counted apart, as aggregate() does
 *   latency  p50 / p90 of the wall-clock turn time, scored tasks only (a 60 s infra
 *            timeout says nothing about how fast a model answers)
 *   dollars  every LLM call of every turn, priced from model-prices.ts, divided by
 *            the number of turns; undefined as soon as one call has no verified price
 */

import { callUsd } from "./model-prices.js";
import type { EvalReport, LlmCallUsage } from "./types.js";
import type { StageModels } from "./model-overrides.js";

export interface RunSummary {
  readonly turns: number;
  readonly scored: number;
  readonly passed: number;
  readonly passRate: number;
  readonly infraErrors: number;
  readonly p50Ms: number | undefined;
  readonly p90Ms: number | undefined;
  readonly llmCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly usd: number | undefined;
  readonly usdPerTurn: number | undefined;
  /** Models that answered at least one call without a verified price, sorted. */
  readonly unpricedModels: readonly string[];
  /** Calls per answering model: what really ran, whatever the config asked for. */
  readonly callsByModel: Readonly<Record<string, number>>;
}

/** Nearest-rank percentile: the ceil(p * n)-th smallest value; undefined for no values. */
export function percentile(values: readonly number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(1, Math.ceil(p * sorted.length)) - 1];
}

export function summarizeRun(report: EvalReport, onDate: string): RunSummary {
  const calls: LlmCallUsage[] = report.results.flatMap((r) => r.observation.usage ?? []);
  const latencies = report.results.flatMap((r) => (!r.infraError && r.latencyMs !== undefined ? [r.latencyMs] : []));

  const callsByModel: Record<string, number> = {};
  const unpriced = new Set<string>();
  let usd = 0;
  for (const c of calls) {
    callsByModel[c.model] = (callsByModel[c.model] ?? 0) + 1;
    const cost = callUsd(c, onDate);
    if (cost === undefined) unpriced.add(c.model);
    else usd += cost;
  }
  const priced = calls.length > 0 && unpriced.size === 0;
  const turns = report.results.length;

  return {
    turns,
    scored: report.overall.total,
    passed: report.overall.passed,
    passRate: report.overall.accuracy,
    infraErrors: report.infraErrors,
    p50Ms: percentile(latencies, 0.5),
    p90Ms: percentile(latencies, 0.9),
    llmCalls: calls.length,
    inputTokens: calls.reduce((n, c) => n + c.inputTokens, 0),
    outputTokens: calls.reduce((n, c) => n + c.outputTokens, 0),
    usd: priced ? usd : undefined,
    usdPerTurn: priced && turns > 0 ? usd / turns : undefined,
    unpricedModels: [...unpriced].sort(),
    callsByModel,
  };
}

const seconds = (ms: number | undefined): string => (ms === undefined ? "n/a" : `${(ms / 1000).toFixed(1)}s`);

/** Header (two lines) of the table renderAbRow() fills. */
export function renderAbHeader(): string {
  return [
    "| Config | Planner | Worker + synthesizer | Pass | p50 / p90 | $ / turn | Infra errors |",
    "|---|---|---|---|---|---|---|",
  ].join("\n");
}

/** One table row: the models the run really used and the numbers it measured. */
export function renderAbRow(label: string, stages: StageModels, s: RunSummary): string {
  const pass = `${Math.round(s.passRate * 100)}% (${s.passed}/${s.scored})`;
  const latency = `${seconds(s.p50Ms)} / ${seconds(s.p90Ms)}`;
  const cost = s.usdPerTurn === undefined ? "n/a" : `$${s.usdPerTurn.toFixed(4)}`;
  return `| ${label} | ${stages.planner} | ${stages.worker} | ${pass} | ${latency} | ${cost} | ${s.infraErrors} |`;
}

/** Lines under the table: what really answered, how much it billed, what could not be priced. */
export function renderRunDetail(s: RunSummary): string {
  if (s.llmCalls === 0) return "No LLM calls were recorded, so $ / turn is n/a.";
  const total = s.usd === undefined ? "n/a" : `$${s.usd.toFixed(4)}`;
  const byModel = Object.entries(s.callsByModel)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([model, n]) => `${model} x${n}`)
    .join(", ");
  return [
    `LLM calls: ${s.llmCalls}; tokens in/out: ${s.inputTokens} / ${s.outputTokens}; total ${total}`,
    `Calls by answering model: ${byModel}`,
    ...(s.unpricedModels.length > 0 ? [`No verified price for: ${s.unpricedModels.join(", ")}; $ / turn is n/a.`] : []),
  ].join("\n");
}
