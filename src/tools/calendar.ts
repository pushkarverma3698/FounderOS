/**
 * FounderOS — Google Calendar Tool (Composio-backed)
 * ====================================================
 * Creates calendar events / reminders via Composio's GOOGLECALENDAR_CREATE_EVENT action.
 *
 * ⚠ Composio field names differ from the raw Google Calendar API:
 *   - `start_datetime`  (ISO: "YYYY-MM-DDTHH:MM:SS") — NOT `start.dateTime`
 *   - `end_datetime`    (ISO: "YYYY-MM-DDTHH:MM:SS") — NOT `end.dateTime`
 *   - `timezone`        (e.g. "Europe/Amsterdam")
 *   - `summary`         (event title)
 *   - `description`     (optional notes)
 *
 * All-day events: use T00:00:00 → T23:59:00 (Composio converts to all-day if times are midnight).
 *
 * Connection env vars (defaults are known-active connections, overridable via .env):
 *   COMPOSIO_GCAL_CONN_ID  / COMPOSIO_GCAL_USER_ID
 *
 * HITL: every create_calendar_event call is gated by the LangChain wrapper in agent-tools.ts.
 */

import { childLogger } from "../infra/logger.js";
import { executeComposioAction, getComposioApiKey, getGCalConnectionId, getGCalUserId } from "../infra/composio.js";
import { hasBeenAudited, writeAuditEntry } from "../db/queries.js";
import type { UnifiedTool, ToolResult } from "./index.js";

const log = childLogger({ module: "tool:calendar" });

export interface CreateCalendarEventArgs {
  title: string;
  date: string;           // ISO date "YYYY-MM-DD" (all-day) or "YYYY-MM-DDTHH:MM:SS" (timed)
  end_date?: string;      // ISO end date/time — defaults to 1h later for timed, same day T23:59:00 for all-day
  description?: string;
  timezone?: string;      // default: Europe/Amsterdam
  idempotency_key?: string; // when provided, the same key never creates the event twice
  tenant_id?: string;       // audit-log tenant (defaults to the single tenant)
}

export const calendarTool: UnifiedTool = {
  name: "create_calendar_event",
  description:
    "Create a Google Calendar event or reminder via Composio. Provide title, date, and optional time.",

  input_schema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Event/reminder title" },
      date: {
        type: "string",
        description:
          'Start date/time. All-day: "YYYY-MM-DD". Timed: "YYYY-MM-DDTHH:MM:SS".',
      },
      end_date: {
        type: "string",
        description: "End date/time (ISO). Defaults to +1h for timed events, end-of-day for all-day.",
      },
      description: { type: "string", description: "Optional event description or notes" },
      timezone: {
        type: "string",
        description: "Timezone (e.g. Europe/Amsterdam). Defaults to Europe/Amsterdam.",
      },
    },
    required: ["title", "date"],
  },

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const {
      title,
      date,
      end_date,
      description,
      timezone = "Europe/Amsterdam",
      idempotency_key,
      tenant_id = "turicks",
    } = input as unknown as CreateCalendarEventArgs;

    if (!getComposioApiKey()) {
      return { success: false, error: "COMPOSIO_API_KEY not configured." };
    }

    // Past-date guard — reject events whose start time is already in the past.
    // Append "Z" to treat the datetime string as UTC for consistent comparison.
    // Allow a 60-second grace window for "right now" / "in a moment" events.
    {
      const PAST_DATE_GRACE_MS = 60_000;
      const isAllDay = /^\d{4}-\d{2}-\d{2}$/.test(date);
      const parseable = isAllDay ? `${date}T00:00:00Z` : (date.endsWith("Z") ? date : `${date}Z`);
      const startMs = new Date(parseable).getTime();
      if (!isNaN(startMs) && startMs < Date.now() - PAST_DATE_GRACE_MS) {
        return {
          success: false,
          error: "Cannot create a calendar event in the past. Please provide a future date/time (e.g. 'tomorrow at 3pm').",
        };
      }
    }

    // Idempotency guard — same key never creates the event twice (CLAUDE.md rule #5).
    // Only enforced when a key is supplied (back-compat: keyless calls always create).
    if (idempotency_key && (await hasBeenAudited(idempotency_key))) {
      log.info({ idempotency_key, title }, "Calendar event already created — skipping");
      return { success: true, data: { skipped: true, reason: "idempotency_key already used" } };
    }

    // Composio uses flat start_datetime / end_datetime (YYYY-MM-DDTHH:MM:SS),
    // not the nested start.dateTime / start.date from the raw Google API.
    const isAllDay = /^\d{4}-\d{2}-\d{2}$/.test(date);
    const startDt = isAllDay ? `${date}T00:00:00` : date;
    const endDt = (() => {
      if (end_date) return /^\d{4}-\d{2}-\d{2}$/.test(end_date) ? `${end_date}T23:59:00` : end_date;
      return isAllDay ? `${date}T23:59:00` : addOneHour(date);
    })();

    const args: Record<string, unknown> = {
      summary: title,
      start_datetime: startDt,
      end_datetime: endDt,
      timezone,
    };
    if (description) args["description"] = description;

    try {
      const result = await executeComposioAction(
        "GOOGLECALENDAR_CREATE_EVENT",
        args,
        getGCalConnectionId(),
        getGCalUserId(),
      );

      // Composio wraps the response: result.data.response_data holds the GCal event.
      // Soft-failure detection: if Composio returns a "message" string with no event id,
      // it's an API-level error (e.g. invalid time range), not a thrown exception.
      const outer = result["data"] as Record<string, unknown> | undefined;
      const inner = (outer?.["response_data"] ?? outer) as Record<string, unknown> | undefined;
      const eventId = inner?.["id"] as string | undefined;
      const htmlLink = (outer?.["display_url"] ?? inner?.["htmlLink"]) as string | undefined;

      if (!eventId) {
        // Soft failure — Composio returned a message instead of a created event.
        // No audit entry is written, so a retry can still create the event.
        const msg = (outer?.["message"] ?? "Event creation failed — no event ID returned") as string;
        log.error({ err: msg, title, startDt }, "Calendar soft failure");
        return { success: false, error: msg };
      }

      // Audit log — written ONLY after a confirmed event id, and only when a key
      // was supplied. This is what makes a repeat of the same request a no-op.
      if (idempotency_key) {
        await writeAuditEntry({
          tenant_id,
          action: "create_calendar_event",
          idempotency_key,
          payload: { event_id: eventId, title, start: startDt },
        });
      }

      log.info({ eventId, title, startDt, timezone }, "Calendar event created");
      return {
        success: true,
        data: { event_id: eventId, title, date: startDt, html_link: htmlLink },
      };
    } catch (err) {
      const message = (err as Error).message;
      log.error({ err: message, title, date }, "Calendar event creation failed");
      return { success: false, error: message };
    }
  },
};

// ── Date helpers (pure string arithmetic — no UTC conversion) ─────────────────
//
// Composio treats start_datetime / end_datetime as LOCAL time in the specified
// timezone. Using new Date() and toISOString() silently converts through UTC,
// which gives wrong results for non-UTC timezones (e.g. Amsterdam UTC+2).
// These helpers manipulate the ISO string directly to stay in local time.

/**
 * Add one hour to a local ISO datetime string (YYYY-MM-DDTHH:MM:SS).
 * Does NOT convert through UTC — safe for any timezone.
 */
function addOneHour(dateTimeStr: string): string {
  const tIdx = dateTimeStr.indexOf("T");
  if (tIdx === -1) return `${dateTimeStr}T01:00:00`; // bare date fallback
  const datePart = dateTimeStr.slice(0, tIdx);
  const timePart = dateTimeStr.slice(tIdx + 1).replace(/Z$/, ""); // strip trailing Z
  const [hhStr, mmStr, ssStr] = timePart.split(":");
  const hh = Number(hhStr ?? 0);
  const mm = mmStr ?? "00";
  const ss = ssStr ?? "00";
  if (hh === 23) {
    // Roll over to next day midnight
    return `${nextDay(datePart)}T00:${mm}:${ss}`;
  }
  return `${datePart}T${String(hh + 1).padStart(2, "0")}:${mm}:${ss}`;
}

/**
 * Return the next calendar day for a YYYY-MM-DD string.
 * Uses UTC arithmetic to avoid DST/offset issues with local Date constructor.
 */
function nextDay(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
