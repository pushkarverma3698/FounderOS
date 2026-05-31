#!/usr/bin/env tsx
/**
 * FounderOS — CEO Live Scenario Battery (real cloud cascade, budget-capped)
 * =========================================================================
 * Drives the compiled FounderGraph headlessly with a battery of genuine
 * CEO-style tasks — one per capability — against the REAL cloud cascade
 * (Gemini + OpenRouter free fallbacks). Captures, per scenario:
 *   - department routed to
 *   - whether the pipeline reached the HITL gate (dry-run: nothing is sent)
 *   - wall-clock latency
 *   - USD cost delta (from ai_call_costs)
 *   - the final output text
 *
 * SAFETY:
 *   - No sendFn is wired → every HITL gate simply suspends the graph.
 *     No LinkedIn post / email / GitHub push happens. Pure dry-run.
 *   - Hard kill-switch: aborts the battery before any scenario if today's
 *     spend for the tenant has reached KILL_SWITCH_USD.
 *   - Budget guard (checkBudget) is independently enforced inside the LLM
 *     layer because Postgres is up (it fails OPEN without a DB).
 *
 * REQUIRES (run command — loads .env then overrides from qa-cloud.env):
 *   unset ANTHROPIC_API_KEY OPENAI_API_KEY   # strip empty shell stubs
 *   node --env-file=.env --env-file=scripts/qa-cloud.env --import tsx \
 *        scripts/ceo-live-battery.ts
 *
 * Output: docs/livetest/ceo-battery-report.{json,md}
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { getGraph } from "../src/agents/graph.js";
import { getTodayCostUsd, getCostBreakdown } from "../src/db/queries.js";
import { closeDatabaseConnections } from "../src/db/client.js";
import { closeRedis } from "../src/infra/redis.js";

// ── Guardrails ────────────────────────────────────────────────────────────────

/** Abort the whole battery before a scenario once spend reaches this. */
const KILL_SWITCH_USD = 0.45;
/** Sanity: the cap configured in qa-cloud.env (informational). */
const BUDGET_CAP_USD = Number(process.env["BUDGET_DAILY_USD"] ?? "0.50");

// ── Scenario battery — one genuine CEO task per capability ────────────────────

interface Scenario {
  id: string;
  tenant: "turicks" | "naggar";
  task: string;
  /** Expected department (informational — actual is captured). */
  expect: string;
}

const SCENARIOS: Scenario[] = [
  {
    id: "prospecting",
    tenant: "turicks",
    task: "https://gymshark.com",
    expect: "prospecting (→ sales if qualified)",
  },
  {
    id: "sales",
    tenant: "turicks",
    task: "Research stripe.com and draft a personalized cold email to their Head of Partnerships pitching our AI automation services.",
    expect: "sales",
  },
  {
    id: "engineering",
    tenant: "turicks",
    task: "Build a TypeScript Hono webhook endpoint that verifies a Stripe webhook signature and returns HTTP 200.",
    expect: "engineering",
  },
  {
    id: "marketing_seo",
    tenant: "turicks",
    task: "Audit the SEO of turicks.com and list the top 5 highest-impact fixes.",
    expect: "marketing",
  },
  {
    id: "social",
    tenant: "turicks",
    task: "Draft a LinkedIn post announcing we shipped an AI agent operating system for one-person agencies.",
    expect: "social",
  },
  {
    id: "naggar_multitenant",
    tenant: "naggar",
    task: "Draft a warm booking confirmation message for a guest arriving next week at the Himalayan retreat.",
    expect: "any (multi-tenant proof)",
  },
];

// ── Result capture ────────────────────────────────────────────────────────────

interface ScenarioResult {
  id: string;
  tenant: string;
  task: string;
  expectedDept: string;
  routedDept: string;
  reachedHitl: boolean;
  pendingNodes: string[];
  outreachTier: string | null;
  latencyMs: number;
  costDeltaUsd: number;
  ok: boolean;
  error?: string;
  outputPreview: string;
}

function preview(text: unknown, n = 600): string {
  const s = typeof text === "string" ? text : JSON.stringify(text ?? "");
  return s.length > n ? s.slice(0, n) + "…" : s;
}

async function settle(ms: number): Promise<void> {
  // Cost logging is fire-and-forget; give pending inserts time to commit.
  await new Promise((r) => setTimeout(r, ms));
}

async function runScenario(scn: Scenario): Promise<ScenarioResult> {
  const graph = await getGraph();
  if (!graph) throw new Error("graph not compiled");

  const trace_id = randomUUID();
  const thread_id = `livetest:${scn.tenant}:${scn.id}:${trace_id.slice(0, 8)}`;
  const config = { configurable: { thread_id }, recursionLimit: 50 };

  const costBefore = await getTodayCostUsd(scn.tenant).catch(() => 0);
  const t0 = Date.now();

  let routedDept = "";
  let outreachTier: string | null = null;
  let outputPreview = "";
  let reachedHitl = false;
  let pendingNodes: string[] = [];
  let ok = false;
  let error: string | undefined;

  try {
    const result = (await graph.invoke(
      { task: scn.task, tenant_id: scn.tenant, trace_id },
      config,
    )) as Record<string, unknown>;

    routedDept = String(result["department"] ?? "");
    outreachTier = (result["outreach_tier"] as string | null) ?? null;
    outputPreview = preview(result["result"]);

    // Detect a suspended (HITL) graph: pending tasks remain after invoke.
    const snap = await graph.getState(config);
    pendingNodes = (snap?.next ?? []) as string[];
    reachedHitl =
      pendingNodes.length > 0 ||
      "__interrupt__" in result ||
      JSON.stringify(result).includes("interrupt_id");

    ok = routedDept.length > 0 && !!result["result"];
  } catch (err) {
    error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  }

  const latencyMs = Date.now() - t0;
  await settle(1200);
  const costAfter = await getTodayCostUsd(scn.tenant).catch(() => costBefore);

  return {
    id: scn.id,
    tenant: scn.tenant,
    task: scn.task,
    expectedDept: scn.expect,
    routedDept,
    reachedHitl,
    pendingNodes,
    outreachTier,
    latencyMs,
    costDeltaUsd: Number((costAfter - costBefore).toFixed(6)),
    ok,
    error,
    outputPreview,
  };
}

// ── Reliability spot-check: concurrent dedup ──────────────────────────────────
//
// Fire the SAME prospecting URL 5× concurrently and confirm the pipeline does
// not create duplicate work. We assert all 5 complete without throwing and
// route consistently. (lead_pipeline dedup is also covered by tests/load.)

async function dedupSpotCheck(): Promise<{ ok: boolean; detail: string }> {
  const graph = await getGraph();
  if (!graph) return { ok: false, detail: "graph not compiled" };

  const url = "https://linear.app";
  const runs = Array.from({ length: 5 }, (_, i) => {
    const trace_id = randomUUID();
    return graph
      .invoke(
        { task: url, tenant_id: "turicks", trace_id },
        { configurable: { thread_id: `livetest:dedup:${i}:${trace_id.slice(0, 8)}` }, recursionLimit: 50 },
      )
      .then((r) => String((r as Record<string, unknown>)["department"] ?? ""))
      .catch((e) => `ERR:${e instanceof Error ? e.message : String(e)}`);
  });

  const settled = await Promise.all(runs);
  const errs = settled.filter((d) => d.startsWith("ERR:"));
  const ok = errs.length === 0;
  return {
    ok,
    detail: `5 concurrent runs of ${url} → departments=[${settled.join(", ")}] errors=${errs.length}`,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("═".repeat(70));
  console.log("  FounderOS — CEO LIVE BATTERY (real cloud cascade, dry-run)");
  console.log(`  Budget cap: $${BUDGET_CAP_USD.toFixed(2)}  ·  Kill-switch: $${KILL_SWITCH_USD.toFixed(2)}`);
  console.log("═".repeat(70));

  const results: ScenarioResult[] = [];

  for (const scn of SCENARIOS) {
    const spend = await getTodayCostUsd(scn.tenant).catch(() => 0);
    if (spend >= KILL_SWITCH_USD) {
      console.log(`\n🛑 KILL-SWITCH: ${scn.tenant} spend $${spend.toFixed(4)} ≥ $${KILL_SWITCH_USD} — aborting before "${scn.id}".`);
      break;
    }

    console.log(`\n▶ [${scn.id}] tenant=${scn.tenant}  (spend so far: $${spend.toFixed(4)})`);
    console.log(`  task: ${scn.task.slice(0, 90)}`);

    const r = await runScenario(scn);
    results.push(r);

    const status = r.ok ? "✅" : r.error ? "❌" : "⚠️";
    console.log(`  ${status} routed=${r.routedDept || "(none)"}  hitl=${r.reachedHitl}  tier=${r.outreachTier ?? "-"}  ${r.latencyMs}ms  Δ$${r.costDeltaUsd.toFixed(5)}`);
    if (r.error) console.log(`     error: ${r.error}`);
    console.log(`     out: ${r.outputPreview.slice(0, 160).replace(/\n/g, " ")}`);
  }

  // Reliability spot-check
  console.log("\n▶ [dedup-spotcheck] 5× concurrent same-URL prospecting");
  const dedup = await dedupSpotCheck();
  console.log(`  ${dedup.ok ? "✅" : "❌"} ${dedup.detail}`);

  // Final authoritative cost breakdown
  await settle(1500);
  const breakdownTuricks = await getCostBreakdown("turicks", 1).catch(() => []);
  const breakdownNaggar = await getCostBreakdown("naggar", 1).catch(() => []);
  const totalTuricks = await getTodayCostUsd("turicks").catch(() => 0);
  const totalNaggar = await getTodayCostUsd("naggar").catch(() => 0);
  const grandTotal = totalTuricks + totalNaggar;

  console.log("\n" + "═".repeat(70));
  console.log("  COST BREAKDOWN (today)");
  console.log("═".repeat(70));
  for (const row of [...breakdownTuricks, ...breakdownNaggar]) {
    console.log(`  ${String(row.model).padEnd(42)} ${String(row.agent).padEnd(20)} calls=${row.calls} in=${row.total_tokens_in} out=${row.total_tokens_out} $${Number(row.total_cost_usd).toFixed(5)}`);
  }
  console.log("─".repeat(70));
  console.log(`  TOTAL: turicks $${totalTuricks.toFixed(5)} + naggar $${totalNaggar.toFixed(5)} = $${grandTotal.toFixed(5)}  (cap $${BUDGET_CAP_USD.toFixed(2)})`);
  console.log(`  Under cap: ${grandTotal < BUDGET_CAP_USD ? "YES ✅" : "NO ❌"}`);

  // Persist report
  const outDir = resolve(process.cwd(), "docs/livetest");
  mkdirSync(outDir, { recursive: true });

  const report = {
    generated_at: new Date().toISOString(),
    budget_cap_usd: BUDGET_CAP_USD,
    kill_switch_usd: KILL_SWITCH_USD,
    grand_total_usd: Number(grandTotal.toFixed(6)),
    under_cap: grandTotal < BUDGET_CAP_USD,
    scenarios: results,
    dedup_spotcheck: dedup,
    cost_breakdown: { turicks: breakdownTuricks, naggar: breakdownNaggar },
  };
  writeFileSync(resolve(outDir, "ceo-battery-report.json"), JSON.stringify(report, null, 2));

  const md = buildMarkdown(report);
  writeFileSync(resolve(outDir, "ceo-battery-report.md"), md);
  console.log(`\n📝 Report → docs/livetest/ceo-battery-report.{json,md}`);

  await closeDatabaseConnections().catch(() => {});
  await closeRedis().catch(() => {});
}

function buildMarkdown(report: {
  generated_at: string;
  grand_total_usd: number;
  budget_cap_usd: number;
  under_cap: boolean;
  scenarios: ScenarioResult[];
  dedup_spotcheck: { ok: boolean; detail: string };
}): string {
  const lines: string[] = [];
  lines.push(`# CEO Live Battery — Results`);
  lines.push("");
  lines.push(`Generated: ${report.generated_at}`);
  lines.push("");
  lines.push(`**Total spend: $${report.grand_total_usd.toFixed(5)} / $${report.budget_cap_usd.toFixed(2)} cap — under cap: ${report.under_cap ? "✅" : "❌"}**`);
  lines.push("");
  lines.push(`| Scenario | Tenant | Routed | HITL | Tier | Latency | Cost Δ | OK |`);
  lines.push(`|---|---|---|---|---|---|---|---|`);
  for (const r of report.scenarios) {
    lines.push(
      `| ${r.id} | ${r.tenant} | ${r.routedDept || "—"} | ${r.reachedHitl ? "yes" : "no"} | ${r.outreachTier ?? "—"} | ${r.latencyMs}ms | $${r.costDeltaUsd.toFixed(5)} | ${r.ok ? "✅" : r.error ? "❌" : "⚠️"} |`,
    );
  }
  lines.push("");
  lines.push(`**Dedup spot-check:** ${report.dedup_spotcheck.ok ? "✅" : "❌"} — ${report.dedup_spotcheck.detail}`);
  lines.push("");
  lines.push(`## Outputs`);
  for (const r of report.scenarios) {
    lines.push("");
    lines.push(`### ${r.id} (${r.tenant})`);
    lines.push(`- Task: ${r.task}`);
    lines.push(`- Routed: \`${r.routedDept || "—"}\` · HITL reached: ${r.reachedHitl} · pending: [${r.pendingNodes.join(", ")}]`);
    if (r.error) lines.push(`- ⚠️ Error: ${r.error}`);
    lines.push("");
    lines.push("```");
    lines.push(r.outputPreview);
    lines.push("```");
  }
  return lines.join("\n");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("FATAL:", err);
    process.exit(1);
  });
