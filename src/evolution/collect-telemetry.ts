/**
 * M0a — Evolution Engine v0: telemetry data collector.
 * ====================================================
 * Fetches database rows for telemetry analyzers and maps them to narrow,
 * decoupled row contracts. This is the ONLY module in src/evolution/ allowed
 * to touch the database.
 */

import { gte } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { aiCallCosts, failureLessons } from "../db/schema.js";
import type { CostRow, LessonRow } from "./types.js";

/** Milliseconds in one 24-hour day. */
const MS_PER_DAY = 86_400_000;

/** Default query window for cost telemetry rows in days. */
export const DEFAULT_COST_WINDOW_DAYS = 30;

/**
 * Fetch LLM call cost rows created within the last N days (defaults to 30).
 * Safely parses numeric cost strings into numbers and skips non-finite values.
 */
export async function collectCostRows(
  sinceDays: number = DEFAULT_COST_WINDOW_DAYS,
): Promise<CostRow[]> {
  const db = getDb();
  const since = new Date(Date.now() - sinceDays * MS_PER_DAY);

  const rows = await db
    .select({
      agent: aiCallCosts.agent,
      model: aiCallCosts.model,
      tokens_in: aiCallCosts.tokens_in,
      tokens_out: aiCallCosts.tokens_out,
      cost_usd: aiCallCosts.cost_usd,
    })
    .from(aiCallCosts)
    .where(gte(aiCallCosts.created_at, since));

  const result: CostRow[] = [];
  for (const r of rows) {
    const cost = Number(r.cost_usd);
    if (!Number.isFinite(cost)) continue;

    result.push({
      agent: r.agent,
      model: r.model,
      tokens_in: r.tokens_in,
      tokens_out: r.tokens_out,
      cost_usd: cost,
    });
  }

  return result;
}

/**
 * Fetch failure lesson rows for failure and memory seam analyzers.
 */
export async function collectLessonRows(): Promise<LessonRow[]> {
  const db = getDb();

  const rows = await db
    .select({
      worker: failureLessons.worker,
      signature: failureLessons.signature,
      component: failureLessons.component,
      times_seen: failureLessons.times_seen,
      times_resolved: failureLessons.times_resolved,
      times_applied: failureLessons.times_applied,
    })
    .from(failureLessons);

  return rows.map((r) => ({
    worker: r.worker,
    signature: r.signature,
    component: r.component,
    times_seen: r.times_seen,
    times_resolved: r.times_resolved,
    times_applied: r.times_applied,
  }));
}
