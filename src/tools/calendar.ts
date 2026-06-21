/**
 * FounderOS — Google Calendar Tool
 * ===================================
 * Creates calendar events via provider backend (gws default).
 * HITL: gated by agent-tools wrapper.
 *
 * See ADR-029.
 */

import { childLogger } from "../infra/logger.js";
import { hasBeenAudited, writeAuditEntry } from "../db/queries.js";
import { providerCreateCalendarEvent } from "../infra/providers/index.js";
import { getCalendarBackend } from "../infra/provider-config.js";
import type { UnifiedTool, ToolResult } from "./index.js";

const log = childLogger({ module: "tool:calendar" });

export interface CreateCalendarEventArgs {
  title: string;
  date: string;
  end_date?: string;
  description?: string;
  timezone?: string;
  idempotency_key?: string;
  tenant_id?: string;
  account_key?: string;
  department?: string;
}

export const calendarTool: UnifiedTool = {
  name: "create_calendar_event",
  description: "Create a Google Calendar event or reminder. Provide title, date, and optional time.",

  input_schema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Event/reminder title" },
      date: {
        type: "string",
        description: 'Start date/time. All-day: "YYYY-MM-DD". Timed: "YYYY-MM-DDTHH:MM:SS".',
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
      account_key,
      department,
    } = input as unknown as CreateCalendarEventArgs;

    // Past-date guard
    {
      const PAST_DATE_GRACE_MS = 60_000;
      const isAllDay = /^\d{4}-\d{2}-\d{2}$/.test(date);
      const parseable = isAllDay ? `${date}T00:00:00Z` : date.endsWith("Z") ? date : `${date}Z`;
      const startMs = new Date(parseable).getTime();
      if (!isNaN(startMs) && startMs < Date.now() - PAST_DATE_GRACE_MS) {
        return {
          success: false,
          error:
            "Cannot create a calendar event in the past. Please provide a future date/time (e.g. 'tomorrow at 3pm').",
        };
      }
    }

    if (idempotency_key && (await hasBeenAudited(idempotency_key))) {
      log.info({ idempotency_key, title }, "Calendar event already created — skipping");
      return { success: true, data: { skipped: true, reason: "idempotency_key already used" } };
    }

    const isAllDay = /^\d{4}-\d{2}-\d{2}$/.test(date);
    const startDt = isAllDay ? `${date}T00:00:00` : date;
    const endDt = (() => {
      if (end_date) return /^\d{4}-\d{2}-\d{2}$/.test(end_date) ? `${end_date}T23:59:00` : end_date;
      return isAllDay ? `${date}T23:59:00` : addOneHour(date);
    })();

    const result = await providerCreateCalendarEvent({
      title,
      start_datetime: startDt,
      end_datetime: endDt,
      timezone,
      description,
      account_key,
      department,
    });

    if (!result.success) {
      return result;
    }

    const data = result.data as Record<string, unknown> | undefined;
    const eventId = data?.["event_id"] as string | undefined;
    if (!eventId) {
      return { success: false, error: "Event creation failed — provider returned no event id" };
    }

    if (idempotency_key) {
      const audit = await writeAuditEntry({
        tenant_id,
        action: "create_calendar_event",
        idempotency_key,
        payload: { event_id: eventId, title, start: startDt, backend: getCalendarBackend() },
      });
      if (!audit.written) {
        log.warn({ idempotency_key }, "writeAuditEntry: conflict on calendar event");
      }
    }

    log.info({ eventId, title, startDt, timezone }, "Calendar event created");
    return {
      success: true,
      data: {
        event_id: eventId,
        title,
        date: startDt,
        html_link: data?.["html_link"],
      },
    };
  },
};

function addOneHour(dateTimeStr: string): string {
  const tIdx = dateTimeStr.indexOf("T");
  if (tIdx === -1) return `${dateTimeStr}T01:00:00`;
  const datePart = dateTimeStr.slice(0, tIdx);
  const timePart = dateTimeStr.slice(tIdx + 1).replace(/Z$/, "");
  const [hhStr, mmStr, ssStr] = timePart.split(":");
  const hh = Number(hhStr ?? 0);
  const mm = mmStr ?? "00";
  const ss = ssStr ?? "00";
  if (hh === 23) {
    return `${nextDay(datePart)}T00:${mm}:${ss}`;
  }
  return `${datePart}T${String(hh + 1).padStart(2, "0")}:${mm}:${ss}`;
}

function nextDay(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
