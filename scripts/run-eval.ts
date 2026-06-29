/**
 * FounderOS — Eval Runner (live)
 * ===============================
 * Runs the golden-task set through the REAL office graph, scores routing / tool
 * selection / HITL coverage, and writes EVAL.md at the repo root.
 *
 * Safety: the invoker observes each run up to the approval pause and NEVER
 * approves, so no email / LinkedIn post / GitHub write ever fires during an eval
 * (side effects only happen after approval). Each task uses a throwaway thread.
 *
 * Usage:
 *   pnpm eval                # full golden set
 *   npx tsx scripts/run-eval.ts
 *
 * Requires a populated .env (Gemini key, DATABASE_URL, etc.) and Postgres up.
 * This makes real LLM calls — run it deliberately, not in a tight loop.
 */

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getOffice, getPendingApproval } from "../src/agents/office.js";
import { GOLDEN_TASKS, CREATIVE_GOLDEN_TASKS } from "../src/eval/golden-tasks.js";
import { CREATIVE_SUBGRAPH_ENABLED } from "../src/core/config.js";
import { runEval } from "../src/eval/runner.js";
import { renderReport } from "../src/eval/report.js";
import { makeOfficeInvoker } from "../src/eval/office-invoker.js";
import { closeDatabaseConnections } from "../src/db/client.js";

async function main(): Promise<void> {
  // Creative tasks only run when the creative dept is actually wired in, else the
  // route can never resolve and the cases would falsely fail.
  const tasks = CREATIVE_SUBGRAPH_ENABLED
    ? [...GOLDEN_TASKS, ...CREATIVE_GOLDEN_TASKS]
    : GOLDEN_TASKS;
  console.log(`\n🧪 FounderOS eval — ${tasks.length} golden tasks${CREATIVE_SUBGRAPH_ENABLED ? " (incl. creative)" : ""}\n`);

  const office = await getOffice();
  // getPendingApproval has a compatible (office, config) signature.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const invoke = makeOfficeInvoker(office as any, getPendingApproval as any);

  const report = await runEval(tasks, invoke, { taskDelayMs: 1500 });
  const md = renderReport(report);

  const outPath = resolve(process.cwd(), "EVAL.md");
  await writeFile(outPath, md, "utf-8");

  // Console summary
  const pc = (n: number) => `${Math.round(n * 100)}%`;
  console.log("─".repeat(48));
  console.log(`Routing       ${report.routing.passed}/${report.routing.total}  ${pc(report.routing.accuracy)}`);
  console.log(`Tool select   ${report.toolSelection.passed}/${report.toolSelection.total}  ${pc(report.toolSelection.accuracy)}`);
  console.log(`HITL coverage ${report.hitlCoverage.passed}/${report.hitlCoverage.total}  ${pc(report.hitlCoverage.accuracy)}`);
  console.log(`Overall       ${report.overall.passed}/${report.overall.total}  ${pc(report.overall.accuracy)}`);
  console.log("─".repeat(48));
  const failures = report.results.filter((r) => !r.passed);
  if (failures.length > 0) {
    console.log(`\n❌ ${failures.length} failing task(s): ${failures.map((r) => r.task.id).join(", ")}`);
  } else {
    console.log("\n✅ All golden tasks passed.");
  }
  console.log(`\n📄 Wrote ${outPath}\n`);
}

main()
  .catch((err) => {
    console.error("Eval failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabaseConnections().catch(() => {});
    // Force exit — grammy/pg can keep handles open.
    setTimeout(() => process.exit(process.exitCode ?? 0), 200);
  });
