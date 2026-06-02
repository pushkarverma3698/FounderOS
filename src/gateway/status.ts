/**
 * FounderOS — /status command helper
 * ====================================
 * Pure formatting logic extracted for testability.
 * The Telegram handler calls getSystemStatus() → formatStatusMessage().
 */

import { childLogger } from "../infra/logger.js";
import { getDb } from "../db/client.js";
import { hitlApprovals, actionLog } from "../db/schema.js";
import { eq, and, gte, count } from "drizzle-orm";

const log = childLogger({ module: "gateway:status" });

// ── Pure formatting (no I/O) ──────────────────────────────────────────────────

export interface StatusData {
  uptimeSeconds: number;
  pendingApprovals: number;
  emailsSentToday: number;
}

/** Format uptime into a human-readable string: "2h 15m", "45s", "10m". */
function formatUptime(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

/** Format the status data into a Telegram HTML message. */
export function formatStatusMessage(data: StatusData): string {
  const { uptimeSeconds, pendingApprovals, emailsSentToday } = data;
  const approvalLine =
    pendingApprovals > 0
      ? `⏳ <b>${pendingApprovals}</b> pending approval${pendingApprovals > 1 ? "s" : ""}`
      : `✅ 0 pending approvals`;

  return (
    `📊 <b>FounderOS Status</b>\n\n` +
    `⏱ Uptime: <code>${formatUptime(uptimeSeconds)}</code>\n` +
    `${approvalLine}\n` +
    `📧 Emails sent today: <b>${emailsSentToday}</b>`
  );
}

// ── Live data query ───────────────────────────────────────────────────────────

/** Query DB for real-time status data. */
export async function getSystemStatus(): Promise<StatusData> {
  const db = getDb();

  try {
    // Pending approvals
    const [approvalRow] = await db
      .select({ total: count() })
      .from(hitlApprovals)
      .where(eq(hitlApprovals.status, "pending"));

    // Emails sent today
    const todayMidnight = new Date();
    todayMidnight.setHours(0, 0, 0, 0);

    const [emailRow] = await db
      .select({ total: count() })
      .from(actionLog)
      .where(
        and(
          eq(actionLog.action, "send_email"),
          gte(actionLog.created_at, todayMidnight),
        ),
      );

    return {
      uptimeSeconds: process.uptime(),
      pendingApprovals: approvalRow?.total ?? 0,
      emailsSentToday: emailRow?.total ?? 0,
    };
  } catch (err) {
    log.error({ err: (err as Error).message }, "Status query failed — returning partial data");
    return {
      uptimeSeconds: process.uptime(),
      pendingApprovals: 0,
      emailsSentToday: 0,
    };
  }
}
