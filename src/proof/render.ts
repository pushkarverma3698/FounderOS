/**
 * FounderOS v3 — proof-artifact renderers (pure).
 * ================================================
 * The marketing evidence is GENERATED from real state, never hand-written:
 *  - scoreboard: test counts + architecture-debt ratchet + kernel guarantees
 *  - cost ledger: per-model spend rows from ai_call_costs
 *  - case study: a completed mission straight from the checkpoint record
 * All functions here are pure — I/O lives in scripts/proof-*.ts.
 */

import type { Mission, StepResult } from "../kernel/contracts.js";

// ── Scoreboard ────────────────────────────────────────────────────────────────

export interface ScoreboardInput {
  generatedAt: string;
  commit: string;
  suite: { files: number; tests: number; failed: number };
  kernelScenarios: string[];
  archBaseline: Record<string, number>;
  evalAccuracy?: number | undefined;
}

export function renderScoreboard(input: ScoreboardInput): string {
  const suiteLine =
    input.suite.failed === 0
      ? `✅ ${input.suite.tests} tests / ${input.suite.files} files — all green`
      : `❌ ${input.suite.failed} of ${input.suite.tests} tests FAILING`;
  const debtLines = Object.entries(input.archBaseline)
    .map(([rule, n]) => `| ${rule} | ${n === 0 ? "0 ✅" : String(n)} |`)
    .join("\n");
  return [
    `# FounderOS Proof Scoreboard`,
    ``,
    `_Generated ${input.generatedAt} · commit \`${input.commit}\` · regenerate with \`pnpm proof:scoreboard\`_`,
    ``,
    `## Deterministic test suite (offline, $0)`,
    ``,
    suiteLine,
    ``,
    `## Kernel guarantees (each one is an executable scenario, not a claim)`,
    ``,
    ...input.kernelScenarios.map((s) => `- ${s}`),
    ``,
    `## Architecture-debt ratchet (CI-enforced: may only shrink)`,
    ``,
    `| rule | open violations |`,
    `|---|---|`,
    debtLines,
    ``,
    ...(input.evalAccuracy !== undefined
      ? [`## Live routing eval`, ``, `Golden-set accuracy: **${(input.evalAccuracy * 100).toFixed(0)}%**`, ``]
      : []),
  ].join("\n");
}

// ── Cost ledger ───────────────────────────────────────────────────────────────

export interface CostRow {
  day: string;
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  usd: number;
}

export function renderCostLedger(rows: CostRow[], capUsd: number): string {
  const total = rows.reduce((a, r) => a + r.usd, 0);
  const body = rows
    .map(
      (r) =>
        `| ${r.day} | ${r.model} | ${r.calls} | ${r.inputTokens.toLocaleString()} | ${r.outputTokens.toLocaleString()} | $${r.usd.toFixed(4)} |`,
    )
    .join("\n");
  return [
    `# Cost & Latency Ledger`,
    ``,
    `Total (window): **$${total.toFixed(2)}** · daily cap: $${capUsd.toFixed(2)}`,
    ``,
    `| day | model | calls | input tok | output tok | usd |`,
    `|---|---|---|---|---|---|`,
    body,
    ``,
  ].join("\n");
}

// ── Case study ────────────────────────────────────────────────────────────────

export interface CaseStudyInput {
  mission: Mission;
  results: StepResult[];
  /** Anonymizer applied to every free-text field (emails/names → placeholders). */
  anonymize?: (text: string) => string;
}

export function renderCaseStudy(input: CaseStudyInput): string {
  const anon = input.anonymize ?? ((t: string) => t.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "<email>"));
  const steps = (input.mission.plan?.steps ?? []).map((step) => {
    const result = input.results.filter((r) => r.step_id === step.step_id).at(-1);
    const outcome =
      !result ? "not reached"
      : result.status === "ok"
        ? `✅ ok — ${result.tool_receipts.filter((t) => t.ok).length} receipt(s)`
        : `❌ ${result.failure.stage}: ${anon(result.failure.message)}`;
    const receipts =
      result?.status === "ok"
        ? result.tool_receipts.map((t) => `  - receipt: \`${t.tool}\` @ ${t.at} (\`${t.args_hash.slice(0, 12)}\`)`)
        : [];
    return [`### ${step.step_id} → ${step.worker}`, ``, `> ${anon(step.objective)}`, ``, `Outcome: ${outcome}`, ...receipts, ``];
  });
  return [
    `# Case Study: ${anon(input.mission.goal)}`,
    ``,
    `Status: **${input.mission.status}** · steps: ${input.mission.plan?.steps.length ?? 0}`,
    ``,
    `Every step below is reproduced from the append-only checkpoint record —`,
    `the plan, outputs, and cryptographic tool receipts are system-generated, not written by hand.`,
    ``,
    ...steps.flat(),
  ].join("\n");
}
