/**
 * FounderOS v3 — routing/tool/HITL eval against the REAL kernel + model.
 * Usage: pnpm eval   (requires a live model key; milestone gate, not a dev loop)
 */

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { MemorySaver } from "@langchain/langgraph";
import { GOLDEN_TASKS } from "../src/eval/golden-tasks.js";
import { COMMAND_GOLDEN_TASKS } from "../src/eval/command-golden.js";
import { UNDERSTANDING_GOLDEN_TASKS } from "../src/eval/understanding-golden.js";
import type { GoldenTask } from "../src/eval/types.js";
import { runEval } from "../src/eval/runner.js";
import { renderReport } from "../src/eval/report.js";
import { makeKernelInvoker } from "../src/eval/kernel-invoker.js";
import { buildProductionKernel } from "../src/gateway/kernel-boot.js";
import { closeDatabaseConnections } from "../src/db/client.js";

/** Default suite unless `--commands` or `--suite <name>` is given. */
function selectTasks(argv: string[]): GoldenTask[] {
  if (argv.includes("--commands")) return COMMAND_GOLDEN_TASKS;
  const at = argv.indexOf("--suite");
  if (at === -1) return GOLDEN_TASKS;
  const name = argv[at + 1];
  if (name === "understanding") return UNDERSTANDING_GOLDEN_TASKS;
  throw new Error(`Unknown suite "${name ?? ""}". Known suites: understanding`);
}

async function main(): Promise<void> {
  // MemorySaver: eval threads are throwaway; no Postgres checkpoint pollution.
  const kernel = buildProductionKernel(new MemorySaver());
  // `pnpm eval -- --commands` runs only the plain-words → slash-command slice (model-pool gate).
  // `pnpm eval -- --suite understanding` runs only the multi-turn understanding set (AG-030).
  const tasks = selectTasks(process.argv);
  const report = await runEval(tasks, makeKernelInvoker(kernel), { taskDelayMs: 500 });
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
