/**
 * FounderOS v3 — case-study exporter.
 * Reproduces a completed mission (plan → steps → receipts → outcome) from the
 * append-only checkpoint record as anonymized markdown — system-generated
 * client proof, not hand-written marketing.
 *
 * Usage: node --env-file=.env --import tsx/esm scripts/export-case-study.ts <thread_id> [out.md]
 */

import { writeFileSync } from "node:fs";
import { getKernel } from "../src/gateway/kernel-boot.js";
import { renderCaseStudy } from "../src/proof/render.js";
import { closeDatabaseConnections } from "../src/db/client.js";
import type { Mission, StepResult } from "../src/kernel/contracts.js";

async function main(): Promise<void> {
  const threadId = process.argv[2];
  if (!threadId) {
    console.error("Usage: export-case-study.ts <thread_id> [out.md]");
    process.exit(1);
  }
  const kernel = await getKernel();
  const state = await kernel.getState({ configurable: { thread_id: threadId } });
  const values = state.values as { mission?: Mission; results?: StepResult[] };
  if (!values.mission?.plan) {
    console.error(`Thread ${threadId} has no recorded mission plan — nothing to export.`);
    process.exit(1);
  }
  const md = renderCaseStudy({ mission: values.mission, results: values.results ?? [] });
  const out = process.argv[3] ?? `case-study-${threadId.replace(/[^\w-]/g, "_")}.md`;
  writeFileSync(out, md);
  console.log(md);
  console.log(`\nWritten to ${out}`);
  await closeDatabaseConnections();
}

main().catch((err) => {
  console.error("Export failed:", err);
  process.exit(1);
});
