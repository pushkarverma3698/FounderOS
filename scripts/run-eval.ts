/**
 * FounderOS v3 — routing/tool/HITL eval against the REAL kernel + model.
 * Usage: pnpm eval   (requires a live model key; milestone gate, not a dev loop)
 *
 * Model A/B (AG-031), one config per run:
 *   pnpm eval --suite understanding                       baseline: the config prod runs
 *   pnpm eval --suite understanding --planner-model <id> --worker-model <id>
 *   add --dry-run to build the kernel, print the model per stage and stop: $0, no model call
 * The flags set the same env vars production reads, before the kernel is built; fallback
 * chains are emptied for an override run, so a failing model is an infra error, not a swap.
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
import { makeUsageCollector } from "../src/eval/usage-collector.js";
import { applyOverrides, assertOverridesApplied, assertResponseCacheOff, parseOverrideArgs } from "../src/eval/model-overrides.js";
import type { ModelOverrides, StageModels } from "../src/eval/model-overrides.js";
import { renderAbHeader, renderAbRow, renderRunDetail, summarizeRun } from "../src/eval/run-summary.js";
import { describeStageModels } from "../src/agents/model-truth.js";
import { getConfiguredModelId } from "../src/agents/model.js";
import { buildProductionKernel } from "../src/gateway/kernel-boot.js";
import { closeDatabaseConnections } from "../src/db/client.js";

const TASK_DELAY_MS = 500;
const PASS_THRESHOLD = 0.8;

/** Default suite unless `--commands` or `--suite <name>` is given. */
function selectTasks(argv: string[]): GoldenTask[] {
  if (argv.includes("--commands")) return COMMAND_GOLDEN_TASKS;
  const at = argv.indexOf("--suite");
  if (at === -1) return GOLDEN_TASKS;
  const name = argv[at + 1];
  if (name === "understanding") return UNDERSTANDING_GOLDEN_TASKS;
  throw new Error(`Unknown suite "${name ?? ""}". Known suites: understanding`);
}

const configLabel = (o: ModelOverrides): string => (o.plannerModel || o.workerModel ? "override" : "baseline");

const todayUtc = (): string => new Date().toISOString().slice(0, 10);

async function closeDb(): Promise<void> {
  await closeDatabaseConnections().catch(() => undefined); // allow-failopen: eval teardown
}

async function main(): Promise<void> {
  const argv = process.argv;
  // `pnpm eval -- --commands` runs only the plain-words → slash-command slice (model-pool gate).
  // `pnpm eval -- --suite understanding` runs only the multi-turn understanding set (AG-030).
  const tasks = selectTasks(argv);
  const overrides = parseOverrideArgs(argv);
  applyOverrides(process.env, overrides);
  assertResponseCacheOff(process.env);

  // MemorySaver: eval threads are throwaway; no Postgres checkpoint pollution.
  const kernel = buildProductionKernel(new MemorySaver());
  const stages: StageModels = describeStageModels(getConfiguredModelId());
  assertOverridesApplied(overrides, stages);
  console.log(`Models per stage: planner=${stages.planner} worker=${stages.worker} synthesizer=${stages.synthesizer}`);

  if (argv.includes("--dry-run")) {
    console.log("Dry run: kernel built, no model was called.");
    await closeDb();
    process.exit(0);
  }

  const report = await runEval(tasks, makeKernelInvoker(kernel, makeUsageCollector()), { taskDelayMs: TASK_DELAY_MS });
  const summary = summarizeRun(report, todayUtc());
  const abTable = [renderAbHeader(), renderAbRow(configLabel(overrides), stages, summary), "", renderRunDetail(summary)].join("\n");
  const rendered = `${renderReport(report)}\n\n## Model A/B (AG-031)\n\n${abTable}\n`;
  console.log(rendered);
  const out = resolve("eval-report.md");
  await writeFile(out, rendered);
  console.log(`\nReport written to ${out}`);
  await closeDb();
  process.exit(report.overall.accuracy >= PASS_THRESHOLD ? 0 : 1);
}

main().catch((err) => {
  console.error("Eval failed:", err);
  process.exit(1);
});
