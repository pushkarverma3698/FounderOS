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

export interface RichStatusData {
  uptimeSeconds: number;
  pendingApprovals: number;
  emailsSentToday: number;
  searchesToday: number;
  calendarEventsToday: number;
  activeClients: string[];
  focus: string | null;
  lastEventContent: string | null;
  lastEventRelativeTime: string | null;
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

/** Format the status data into a Telegram HTML message (basic, backwards-compat). */
export function formatStatusMessage(data: StatusData): string {
  const { uptimeSeconds, pendingApprovals, emailsSentToday } = data;
  const approvalLine =
    pendingApprovals > 0
      ? `⏳ <b>${pendingApprovals}</b> pending approval${pendingApprovals > 1 ? "s" : ""}`
      : `✅ 0 pending approvals`;

  return (
    `🟢 <b>FounderOS Status</b>\n\n` +
    `⏱ Uptime: <code>${formatUptime(uptimeSeconds)}</code>\n` +
    `${approvalLine}\n` +
    `📧 Emails sent today: <b>${emailsSentToday}</b>`
  );
}

/**
 * Format the rich status data into a detailed Telegram HTML message.
 * Used by /status command for the enhanced D3 view.
 */
export function formatRichStatus(data: RichStatusData): string {
  const {
    uptimeSeconds,
    pendingApprovals,
    emailsSentToday,
    searchesToday,
    calendarEventsToday,
    activeClients,
    focus,
    lastEventContent,
    lastEventRelativeTime,
  } = data;

  const clientsStr = activeClients.length > 0 ? activeClients.join(", ") : "none set";
  const focusStr = focus ?? "none";

  const lastEventStr =
    lastEventContent !== null
      ? `${lastEventContent.slice(0, 50)}${lastEventContent.length > 50 ? "…" : ""}` +
        (lastEventRelativeTime ? ` (${lastEventRelativeTime})` : "")
      : "no events recorded";

  return (
    `🟢 <b>FounderOS</b> — Running ${formatUptime(uptimeSeconds)}\n\n` +
    `📋 Context: ${clientsStr}, Focus: ${focusStr}\n` +
    `📬 Today: ${emailsSentToday} email${emailsSentToday !== 1 ? "s" : ""} · ${searchesToday} search${searchesToday !== 1 ? "es" : ""} · ${calendarEventsToday} event${calendarEventsToday !== 1 ? "s" : ""}\n` +
    `⚡ Last: ${lastEventStr}\n` +
    `🔒 Pending approvals: ${pendingApprovals}`
  );
}

// ── Error message formatting ─────────────────────────────────────────────────

const ERROR_PATTERNS: Array<[RegExp, string]> = [
  [/FIRECRAWL_API_KEY/, "Search temporarily unavailable. Try again in a moment."],
  [/Firecrawl returned HTTP (\d+)/, "Search unavailable (HTTP $1). Try again."],
  [/Composio returned no (message_id|event_id|id)/, "Action could not complete — check your Composio connection."],
  [/403 Forbidden/, "Permission denied. Check your API token has the right scopes."],
  [/Command timed out after (\d+)s/, "Command timed out ($1s). Break it into smaller steps."],
  [/ECONNREFUSED/, "Service connection failed. Try again in a moment."],
  [/Cannot create a calendar event in the past/, "Cannot create a past calendar event. Please provide a future date."],
];

/**
 * Convert a raw tool error string into a user-friendly message.
 * Returns the raw error unchanged when no pattern matches.
 */
export function formatToolError(rawError: string): string {
  for (const [pattern, message] of ERROR_PATTERNS) {
    if (pattern.test(rawError)) {
      return rawError.replace(pattern, message);
    }
  }
  return rawError;
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
