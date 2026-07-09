/**
 * FounderOS v3 — cost & latency ledger generator.
 * Renders the real ai_call_costs rows (per model, last N days) as markdown —
 * the "we run a business on $X/month of LLM spend" proof, from the database.
 * Usage: pnpm proof:costs [days]   (needs DATABASE_URL)
 */

import { writeFileSync } from "node:fs";
import { getCostBreakdown } from "../src/db/queries.js";
import { renderCostLedger, type CostRow } from "../src/proof/render.js";
import { TENANT, DAILY_BUDGET_USD } from "../src/core/config.js";
import { closeDatabaseConnections } from "../src/db/client.js";

async function main(): Promise<void> {
  const days = Number(process.argv[2] ?? 7);
  const breakdown = await getCostBreakdown(TENANT, days);
  const rows: CostRow[] = breakdown.map((b) => ({
    day: `last ${days}d`,
    model: `${b.model} (${b.agent ?? "-"})`,
    calls: Number(b.calls),
    inputTokens: Number(b.total_tokens_in ?? 0),
    outputTokens: Number(b.total_tokens_out ?? 0),
    usd: Number(b.total_cost_usd ?? 0),
  }));
  const md = renderCostLedger(rows, DAILY_BUDGET_USD);
  writeFileSync("docs/COSTS.md", md);
  console.log(md);
  console.log("Written to docs/COSTS.md");
  await closeDatabaseConnections();
}

main().catch((err) => {
  console.error("Cost ledger failed:", err);
  process.exit(1);
});
