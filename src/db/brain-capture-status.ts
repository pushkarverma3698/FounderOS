/**
 * Mac capture heartbeat for /where (AG-027, audit F7). No table: it reads the rows the capture already wrote,
 * `metadata.origin` in (mac-claude, mac-agy).
 */
import { sql } from "drizzle-orm";
import { db } from "./client.js";

/** Origins written by the Mac capture. */
export const MAC_CAPTURE_ORIGINS = ["mac-claude", "mac-agy"] as const;
/** A capture older than this shows the warning marker. */
export const CAPTURE_STALE_MS = 2 * 60 * 60 * 1000;

export interface CaptureStatus {
  /** `max(created_at)` of Mac-origin rows; null when none exist. */
  readonly lastAt: Date | null;
  /** Mac-origin rows created today in `timeZone`. */
  readonly rowsToday: number;
}

export async function fetchCaptureStatus(timeZone: string): Promise<CaptureStatus> {
  const rows = await db.execute(sql`
    SELECT max(created_at) AS last_at,
           count(*) FILTER (WHERE (created_at AT TIME ZONE ${timeZone})::date = (now() AT TIME ZONE ${timeZone})::date) AS rows_today
    FROM brain.brain_memories
    WHERE metadata->>'origin' IN (${sql.join(MAC_CAPTURE_ORIGINS.map((o) => sql`${o}`), sql`, `)})
  `);
  const row = (rows as unknown as Array<{ last_at: Date | string | null; rows_today: string | number }>)[0];
  const rowsToday = Number(row?.rows_today ?? 0);
  return {
    lastAt: row?.last_at ? new Date(row.last_at) : null,
    rowsToday: Number.isFinite(rowsToday) ? rowsToday : 0,
  };
}

/** One founder-readable line. The warning marker means no new Mac row for over two hours. */
export function renderCaptureLine(status: CaptureStatus, now: Date): string {
  if (!status.lastAt) return "Mac capture: no rows yet ⚠️ (run scripts/mac/install-brain-capture.sh on the Mac)";
  const minutes = Math.max(0, Math.round((now.getTime() - status.lastAt.getTime()) / 60_000));
  const stale = now.getTime() - status.lastAt.getTime() > CAPTURE_STALE_MS;
  return `Mac capture: last ${minutes} min ago, ${status.rowsToday} rows today${stale ? " ⚠️" : ""}`;
}
