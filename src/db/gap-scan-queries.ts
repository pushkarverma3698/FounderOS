/**
 * FounderOS — gap_scans query functions
 * ======================================
 * Named, type-safe queries for the AI Visibility Gap Scanner store — the
 * per-vertical learning-loop dataset (lead-acquisition spec §11). Agents use
 * these (via the get_gap_scans tool) to answer "what did Acme's last scan
 * say?" without rerunning paid surface calls.
 *
 * Kept out of queries.ts: that file is already over the LOC budget and this
 * domain is self-contained (mirrors account-queries.ts).
 */

import { and, desc, eq, type SQL } from "drizzle-orm";
import { getDb } from "./client.js";
import { gapScans, type GapScan, type NewGapScan } from "./schema.js";

const DEFAULT_TENANT = "turicks";

/** Compact row for listings — everything except the heavy JSONB/markdown. */
export interface GapScanSummary {
  id: string;
  target_name: string;
  target_domain: string;
  category: string;
  gap_score: number;
  confidence: string;
  completion_rate: string;
  runs_total: number;
  surfaces: string[];
  created_at: Date | null;
}

const summaryColumns = {
  id: gapScans.id,
  target_name: gapScans.target_name,
  target_domain: gapScans.target_domain,
  category: gapScans.category,
  gap_score: gapScans.gap_score,
  confidence: gapScans.confidence,
  completion_rate: gapScans.completion_rate,
  runs_total: gapScans.runs_total,
  surfaces: gapScans.surfaces,
  created_at: gapScans.created_at,
};

/** Persist one finished scan. Returns the new row id. */
export async function saveGapScan(data: Omit<NewGapScan, "id" | "created_at">): Promise<string> {
  const db = getDb();
  const [row] = await db.insert(gapScans).values(data).returning({ id: gapScans.id });
  if (!row) throw new Error("saveGapScan: insert returned no rows");
  return row.id;
}

/** Latest full scan for a domain (normalized, e.g. "acme.com") — or null. */
export async function getLatestGapScan(
  targetDomain: string,
  tenantId: string = DEFAULT_TENANT,
): Promise<GapScan | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(gapScans)
    .where(and(eq(gapScans.tenant_id, tenantId), eq(gapScans.target_domain, targetDomain)))
    .orderBy(desc(gapScans.created_at))
    .limit(1);
  return rows[0] ?? null;
}

/** Full scan row by id — or null. */
export async function getGapScanById(id: string): Promise<GapScan | null> {
  const db = getDb();
  const rows = await db.select().from(gapScans).where(eq(gapScans.id, id)).limit(1);
  return rows[0] ?? null;
}

/**
 * List scan summaries, newest first. Filter by domain (one company's history —
 * gap-score trend over time) or category (the vertical dataset), or neither.
 */
export async function listGapScans(
  opts: { domain?: string; category?: string; limit?: number; tenantId?: string } = {},
): Promise<GapScanSummary[]> {
  const db = getDb();
  const conditions: SQL[] = [eq(gapScans.tenant_id, opts.tenantId ?? DEFAULT_TENANT)];
  if (opts.domain) conditions.push(eq(gapScans.target_domain, opts.domain));
  if (opts.category) conditions.push(eq(gapScans.category, opts.category));

  return db
    .select(summaryColumns)
    .from(gapScans)
    .where(and(...conditions))
    .orderBy(desc(gapScans.created_at))
    .limit(Math.min(Math.max(opts.limit ?? 10, 1), 50));
}
