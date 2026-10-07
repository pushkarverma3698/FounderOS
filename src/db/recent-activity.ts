/**
 * Recent agent activity from brain_memories (AG-029): the collector behind the planner block and scripts/brain-digest.ts.
 * One SQL query over metadata.origin (AG-026 provenance), newest first. No embedding, no LLM: the planner calls this
 * on every founder DM turn. The pure rendering lives in src/kernel/recent-activity.ts.
 */
import { sql } from "drizzle-orm";
import { db } from "./client.js";

/** Rows fetched at most per read; the renderers cut further (12 in the planner block, 40 in the digest). */
export const RECENT_ACTIVITY_FETCH_LIMIT = 60;

/** Same shape as the kernel's ActivityRow; declared here because db must not import the kernel. */
export interface BrainActivityRow {
  readonly at: Date;
  readonly origin: string;
  readonly project: string | null;
  readonly title: string | null;
  readonly content: string;
}

export interface RecentActivityQuery {
  readonly now: Date;
  /** Only rows created within this many hours before `now`. */
  readonly windowHours?: number;
  /** Absolute start; wins over windowHours when both are given. */
  readonly since?: Date;
  readonly origins: readonly string[];
  readonly project?: string;
  readonly limit?: number;
}

interface RawRow {
  readonly created_at: string | Date | null;
  readonly project: string | null;
  readonly content: string;
  readonly metadata: Record<string, unknown> | null;
}

const asDate = (v: unknown): Date | null => {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
};

/** Raw row to ActivityRow. Pure. A row with no usable time is dropped: a dateless line is not "recent". */
export function toActivityRow(raw: RawRow): BrainActivityRow | null {
  const meta = raw.metadata ?? {};
  const at = asDate(meta["occurred_at"]) ?? asDate(raw.created_at);
  const origin = meta["origin"];
  if (at === null || typeof origin !== "string") return null;
  const title = meta["title"];
  return { at, origin, project: raw.project, title: typeof title === "string" ? title : null, content: raw.content };
}

/** Window start for a query: the explicit `since`, else now minus windowHours (default 36). */
export function windowStart(q: Pick<RecentActivityQuery, "now" | "since" | "windowHours">): Date {
  return q.since ?? new Date(q.now.getTime() - (q.windowHours ?? 36) * 3_600_000);
}

export async function readRecentBrainActivity(q: RecentActivityQuery): Promise<BrainActivityRow[]> {
  if (q.origins.length === 0) return [];
  const origins = sql.join(q.origins.map((o) => sql`${o}`), sql`, `);
  const projectFilter = q.project ? sql`AND project = ${q.project}` : sql``;
  const rows = (await db.execute(sql`
    SELECT created_at, project, content, metadata
    FROM brain.brain_memories
    WHERE status = 'ACTIVE'
      AND metadata->>'origin' IN (${origins})
      AND created_at >= ${windowStart(q).toISOString()}::timestamptz
      ${projectFilter}
    ORDER BY created_at DESC
    LIMIT ${q.limit ?? RECENT_ACTIVITY_FETCH_LIMIT}
  `)) as unknown as RawRow[];
  return rows.map(toActivityRow).filter((r): r is BrainActivityRow => r !== null);
}
