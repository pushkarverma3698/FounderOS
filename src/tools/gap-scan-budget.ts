/**
 * FounderOS — Gap Scanner cost control
 * =====================================
 * A single gap scan fires many paid surface calls (up to prompts × surfaces × N).
 * These helpers gate the scan against the tenant's daily LLM cap BEFORE any paid
 * call and record the scan's spend AFTER, so an autonomous agent can never run
 * uncapped visibility scans (the same discipline as the creative image tool).
 *
 * Dynamic imports keep the DB layer (and its full-env validation) out of the $0
 * test/CLI path — mirrors the persistence seam in gap-scanner.ts. Both helpers
 * are no-ops when no DATABASE_URL is configured (nothing to meter against) and
 * fail OPEN on a telemetry error — a DB blip must never block a read-only scan.
 */

import { childLogger } from "../infra/logger.js";
import { TENANT } from "../core/config.js";
import type { GapReportData } from "./gap-scan-core.js";

const log = childLogger({ module: "tool:gap-scan-budget" });

/**
 * Flat per-completed-call cost estimate for the daily budget ledger. The surface
 * adapters don't yet report token usage, so we attribute a conservative estimate
 * per completed answer — enough for the daily cap to SEE gap-scan spend (rule #14),
 * not a billing-grade figure.
 */
const GAP_SCAN_EST_USD_PER_CALL = 0.01;

/** Block a scan when the tenant is already over its daily LLM cap. */
export async function assertGapScanBudget(): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!process.env["DATABASE_URL"]) return { ok: true };
  try {
    const { getTodayCostUsd } = await import("../db/queries.js");
    const { getDailyBudgetCapUsd, checkDailyBudgetGate } = await import("../infra/daily-budget.js");
    const spent = await getTodayCostUsd(TENANT);
    return checkDailyBudgetGate(spent, getDailyBudgetCapUsd());
  } catch (err) {
    // allow-failopen: budget telemetry unavailable (dev DB / transient outage) must
    // not block a read-only scan; per-run model caps still apply on the surfaces.
    log.warn({ err: err instanceof Error ? err.message : String(err) }, "gap scan budget check failed — allowing");
    return { ok: true };
  }
}

/** Record the scan's estimated spend so the daily budget tracker sees it. */
export async function recordGapScanCost(report: GapReportData): Promise<void> {
  if (!process.env["DATABASE_URL"]) return;
  try {
    const { logLlmCost } = await import("../db/queries.js");
    await logLlmCost({
      tenant_id: TENANT,
      agent: "research",
      tier: "gap-scan",
      model: report.surfaces.join(","),
      tokens_in: 0,
      tokens_out: 0,
      cost_usd: (report.runs_completed * GAP_SCAN_EST_USD_PER_CALL).toFixed(6),
      lead_id: null,
    });
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, "gap scan cost log failed (scan still returned)");
  }
}
