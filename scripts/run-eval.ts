/**
 * FounderOS v3 — routing/tool/HITL eval against the REAL kernel + model.
 * Usage: pnpm eval   (requires a live model key; milestone gate, not a dev loop)
 */

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { MemorySaver } from "@langchain/langgraph";
import { GOLDEN_TASKS } from "../src/eval/golden-tasks.js";
import { runEval } from "../src/eval/runner.js";
import { renderReport } from "../src/eval/report.js";
import { makeKernelInvoker } from "../src/eval/kernel-invoker.js";
import { buildProductionKernel } from "../src/gateway/kernel-boot.js";
import { closeDatabaseConnections } from "../src/db/client.js";

async function main(): Promise<void> {
  // MemorySaver: eval threads are throwaway; no Postgres checkpoint pollution.
  const kernel = buildProductionKernel(new MemorySaver());
  const report = await runEval(GOLDEN_TASKS, makeKernelInvoker(kernel), { taskDelayMs: 500 });
  const rendered = renderReport(report);
  console.log(rendered);
  const out = resolve("eval-report.md");
  await writeFile(out, rendered);
  console.log(`\nReport written to ${out}`);
  await closeDatabaseConnections().catch(() => undefined); // allow-failopen: eval teardown
  process.exit(report.overall.accuracy >= 0.8 ? 0 : 1);
}

main().catch((err) => {
  console.error("Eval failed:", err);
  process.exit(1);
});
