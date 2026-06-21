/**
 * Judge calibration harness.
 *
 * Runs JUDGE_GOLDEN_CASES against the real judge (requires ANTHROPIC_API_KEY).
 * Prints per-channel accuracy and exits 0 if overall >= 80%, 1 otherwise.
 *
 * Usage: pnpm judge:eval
 */

import { judgeOutbound } from "../src/infra/judge.js";
import { judgeRagAnswer } from "../src/infra/judge.js";
import { JUDGE_GOLDEN_CASES, type JudgeGoldenCase } from "../src/eval/judge-golden.js";

if (!process.env["ANTHROPIC_API_KEY"]) {
  console.error("ERROR: ANTHROPIC_API_KEY not set — judge:eval requires a real Claude key.");
  process.exit(1);
}

interface CaseResult {
  id: string;
  channel: string;
  expected: string;
  got: string;
  correct: boolean;
  critique?: string;
}

async function runCase(c: JudgeGoldenCase): Promise<CaseResult> {
  let verdict: { verdict: string; critique?: string };

  if (c.channel === "rag_answer") {
    const v = await judgeRagAnswer(c.input.query ?? "", c.input.chunks ?? []);
    verdict = v;
  } else {
    const ch = c.channel as "linkedin" | "outreach" | "general";
    const v = await judgeOutbound(c.input.text ?? "", ch);
    verdict = v;
  }

  return {
    id: c.id,
    channel: c.channel,
    expected: c.expectedVerdict,
    got: verdict.verdict,
    correct: verdict.verdict === c.expectedVerdict,
    critique: "critique" in verdict ? verdict.critique : undefined,
  };
}

async function main() {
  console.log("\nJudge Calibration Report\n");

  const results: CaseResult[] = [];
  for (const c of JUDGE_GOLDEN_CASES) {
    process.stdout.write(`  running ${c.id}...`);
    try {
      const r = await runCase(c);
      results.push(r);
      console.log(r.correct ? " ✓" : ` ✗ (expected=${r.expected}, got=${r.got})`);
    } catch (err) {
      console.log(` ERROR: ${(err as Error).message}`);
      results.push({ id: c.id, channel: c.channel, expected: c.expectedVerdict, got: "error", correct: false });
    }
  }

  // Per-channel stats
  const channels = [...new Set(results.map((r) => r.channel))];
  const rows: string[] = [];
  let totalCorrect = 0;

  for (const ch of channels) {
    const group = results.filter((r) => r.channel === ch);
    const correct = group.filter((r) => r.correct).length;
    totalCorrect += correct;
    const pct = Math.round((correct / group.length) * 100);
    rows.push(`${ch.padEnd(14)} ${String(group.length).padStart(5)}  ${String(correct).padStart(7)}  ${String(pct).padStart(8)}%`);
  }

  const overall = Math.round((totalCorrect / results.length) * 100);

  console.log(`\n${"Channel".padEnd(14)} ${"Cases".padStart(5)}  ${"Correct".padStart(7)}  ${"Accuracy".padStart(9)}`);
  console.log("─".repeat(42));
  rows.forEach((r) => console.log(r));
  console.log("─".repeat(42));
  console.log(`${"Overall".padEnd(14)} ${String(results.length).padStart(5)}  ${String(totalCorrect).padStart(7)}  ${String(overall).padStart(8)}%`);

  const misses = results.filter((r) => !r.correct);
  if (misses.length > 0) {
    console.log("\nMisclassifications:");
    for (const m of misses) {
      const crit = m.critique ? `  critique="${m.critique}"` : "";
      console.log(`  [${m.id}]  expected=${m.expected}  got=${m.got}${crit}`);
    }
  }

  console.log();
  if (overall >= 80) {
    console.log(`✅ PASS — overall accuracy ${overall}% >= 80%`);
    process.exit(0);
  } else {
    console.log(`❌ FAIL — overall accuracy ${overall}% < 80%`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
