/**
 * FounderOS — Google Calendar Tool (Composio-backed)
 * ====================================================
 * Creates calendar events / reminders via Composio's GOOGLECALENDAR_CREATE_EVENT action.
 *
 * Connection env vars (set in .env):
 *   COMPOSIO_GCAL_CONN_ID   — connected account ID from app.composio.dev
 *   COMPOSIO_GCAL_USER_ID   — entity/user ID from app.composio.dev
 *
 * The agent provides human-friendly inputs; this layer converts to ISO-8601
 * and calls Composio. All-day events use `date`; timed events use `dateTime`.
 *
 * HITL: the LangChain tool wrapper in agent-tools.ts gates every call.
 */

import { childLogger } from "../infra/logger.js";
import { executeComposioAction, getComposioApiKey, getGCalConnectionId, getGCalUserId } from "../infra/composio.js";
import type { UnifiedTool, ToolResult } from "./index.js";

const log = childLogger({ module: "tool:calendar" });

export interface CreateCalendarEventArgs {
  title: string;
  date: string;           // ISO date "YYYY-MM-DD" or dateTime "YYYY-MM-DDTHH:mm:ss"
  end_date?: string;      // defaults to same day (all-day) or +1h (timed)
  description?: string;
  timezone?: string;      // default: Europe/Amsterdam
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
          'Start date/time. ISO format: "YYYY-MM-DD" for all-day, "YYYY-MM-DDTHH:mm:ss" for timed.',
      },
      end_date: {
        type: "string",
        description:
          "End date/time (ISO). Defaults to same day (all-day) or 1 hour after start (timed).",
      },
      description: { type: "string", description: "Optional event description or notes" },
      timezone: {
        type: "string",
        description: "Timezone name (e.g. Europe/Amsterdam). Defaults to Europe/Amsterdam.",
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
    } = input as unknown as CreateCalendarEventArgs;

    if (!getComposioApiKey()) {
      return { success: false, error: "COMPOSIO_API_KEY not configured." };
    }

    // Determine if this is an all-day or timed event
    const isAllDay = /^\d{4}-\d{2}-\d{2}$/.test(date);

    let startObj: Record<string, string>;
    let endObj: Record<string, string>;

    if (isAllDay) {
      startObj = { date };
      // Default end = next day (Google Calendar convention for all-day events)
      const endDate = end_date ?? nextDay(date);
      endObj = { date: endDate };
    } else {
      startObj = { dateTime: date, timeZone: timezone };
      // Default end = 1 hour after start
      const endDt = end_date ?? addOneHour(date);
      endObj = { dateTime: endDt, timeZone: timezone };
    }

    const args: Record<string, unknown> = {
      summary: title,
      start: startObj,
      end: endObj,
    };
    if (description) args["description"] = description;

    try {
      const result = await executeComposioAction(
        "GOOGLECALENDAR_CREATE_EVENT",
        args,
        getGCalConnectionId(),
        getGCalUserId(),
      );

      const data = result["data"] as Record<string, unknown> | undefined;
      const eventId = (data?.["id"] ?? result["id"]) as string | undefined;

      log.info({ eventId, title, date }, "Calendar event created");
      return {
        success: true,
        data: { event_id: eventId, title, date: isAllDay ? date : date, timezone },
      };
    } catch (err) {
      const message = (err as Error).message;
      log.error({ err: message, title, date }, "Calendar event creation failed");
      return { success: false, error: message };
    }
  },
};

// ── Date helpers (pure, no dependencies) ──────────────────────────────────────

function nextDay(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function addOneHour(dateTimeStr: string): string {
  const d = new Date(dateTimeStr);
  d.setHours(d.getHours() + 1);
  // Return in same format as input (no timezone suffix)
  return d.toISOString().slice(0, 19);
}
