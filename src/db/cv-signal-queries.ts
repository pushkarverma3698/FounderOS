/**
 * FounderOS — cv_signals query functions
 * ======================================
 * The demand side of the CV loop: what the roles Pushkar can legally hold
 * actually ask for.
 *
 * Kept out of queries.ts (already over the LOC budget), mirroring
 * job-queries.ts and gap-scan-queries.ts.
 *
 * Every write is an upsert with a SQL-side increment rather than a
 * read-modify-write. Two postings screened concurrently that both mention
 * Kubernetes must produce +2, and a JS-side `count + 1` would produce +1 — a
 * silently low number that looks perfectly plausible in the report.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "./client.js";
import { cvSignals, type CvSignal } from "./schema.js";

const DEFAULT_TENANT = "turicks";

export interface SignalInput {
  readonly term: string;
  readonly category: string;
}

/** Rows screened before tracks existed, and titles no classifier recognises. */
export const UNCLASSIFIED_TRACK = "unclassified";

/**
 * Record one posting's contribution TO ONE TRACK. Each term is bumped by exactly
 * one, because the caller has already de-duplicated within the posting
 * (src/tools/jobhunt/skills.ts) — seen_count is postings, not mentions.
 *
 * The track is part of the identity. "Python, 60%" over a blended pool answers
 * no question the founder can act on: it could be every AI role and no frontend
 * role, and the CV he would change is different in each case.
 */
export async function recordSignals(
  signals: readonly SignalInput[],
  opts: { track?: string; tenantId?: string } = {},
): Promise<number> {
  if (signals.length === 0) return 0;

  const db = getDb();
  const now = new Date();
  const rows = signals.map((s) => ({
    tenant_id: opts.tenantId ?? DEFAULT_TENANT,
    track: opts.track ?? UNCLASSIFIED_TRACK,
    term: s.term,
    category: s.category,
    seen_count: 1,
    first_seen_at: now,
    last_seen_at: now,
  }));

  await db
    .insert(cvSignals)
    .values(rows)
    .onConflictDoUpdate({
      target: [cvSignals.tenant_id, cvSignals.track, cvSignals.term],
      set: {
        // SQL-side increment: concurrent screens must both count.
        seen_count: sql`${cvSignals.seen_count} + 1`,
        // A term can move out of "unknown" once it's promoted into the
        // dictionary; keep the row and let the category follow.
        category: sql`excluded.category`,
        last_seen_at: now,
        updated_at: now,
      },
    });

  return signals.length;
}

/**
 * Signals, most-demanded first — the input to the gap report.
 *
 * Omitting `track` returns every track's rows unaggregated, which is the right
 * answer for an inventory and the wrong one for a gap report. `cv_gaps` always
 * passes a track.
 */
export async function listSignals(
  opts: { category?: string; track?: string; limit?: number; tenantId?: string } = {},
): Promise<CvSignal[]> {
  const db = getDb();
  const conditions = [eq(cvSignals.tenant_id, opts.tenantId ?? DEFAULT_TENANT)];
  if (opts.category) conditions.push(eq(cvSignals.category, opts.category));
  if (opts.track) conditions.push(eq(cvSignals.track, opts.track));

  return db
    .select()
    .from(cvSignals)
    .where(and(...conditions))
    .orderBy(desc(cvSignals.seen_count))
    .limit(opts.limit ?? 200);
}

