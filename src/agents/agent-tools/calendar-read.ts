/**
 * Comms: read Google Calendar (READ — no approval). The founder asked "what's on my calendar today?" and the bot
 * answered "no calendar read tool" (J2, 2026-10-09): comms carried create_calendar_event only. The read already
 * existed (gwsListCalendarEvents, used by the VPS hub); this wraps it for the worker.
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { appTimeZone, wallDate, zonedTimeToUtc } from "../../core/time.js";
import { listGoogleMailboxes, mailboxNamedIn } from "../../infra/google-mailboxes.js";
import { gwsListCalendarEvents } from "../../infra/providers/google-gws.js";

const MAX_DAYS = 31;
const MAX_EVENTS = 50;
const DAY_MS = 86_400_000;

/** [time_min, time_max) for `days` days from `from` (YYYY-MM-DD = that local day's start; ISO datetime as given; default today). */
export function calendarWindow(
  opts: { from?: string | null; days?: number | null },
  now: Date,
  timeZone: string,
): { time_min: string; time_max: string } {
  const days = Math.min(MAX_DAYS, Math.max(1, Math.floor(Number(opts.days ?? 1)) || 1));
  const dayStart = (d: Date): Date => {
    const w = wallDate(d, timeZone);
    return zonedTimeToUtc(w.y, w.mo, w.d, 0, 0, timeZone);
  };
  const raw = opts.from?.trim() ?? "";
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? dayStart(new Date(`${raw}T12:00:00Z`)) : raw ? new Date(raw) : undefined;
  const start = parsed && !Number.isNaN(parsed.getTime()) ? parsed : dayStart(now);
  // Whole local days: a DST change inside the span moves the end by at most an hour, which a day window tolerates.
  return { time_min: start.toISOString(), time_max: new Date(start.getTime() + days * DAY_MS).toISOString() };
}

export const listCalendarEvents = tool(
  async ({ from, days, account }, config) => {
    // The mailbox the founder named in his own words outranks the model's pick (same rule as read_emails).
    const named = mailboxNamedIn(String(config?.configurable?.["founder_text"] ?? ""), listGoogleMailboxes());
    const window = calendarWindow({ from, days }, new Date(), appTimeZone());
    const res = await gwsListCalendarEvents({
      account_key: named ?? account ?? undefined,
      ...window,
      max_results: MAX_EVENTS,
    });
    if (!res.success) return `Calendar read failed: ${res.error ?? "unknown error"}.`;
    return `Events from ${window.time_min} to ${window.time_max}:\n${String(res.data)}`;
  },
  {
    name: "list_calendar_events",
    description:
      "Read events from Google Calendar (primary calendar), read-only — no approval. Default is today in the founder's timezone; " +
      "give `from` (YYYY-MM-DD or ISO datetime) and `days` for another day or a longer span. Use for 'what's on my calendar', 'am I free at 3'.",
    schema: z.object({
      from: z.string().optional().nullable().describe("Start: YYYY-MM-DD (that day) or ISO 8601 datetime. Default: today."),
      days: z.number().optional().nullable().describe("How many days from the start, 1-31 (default 1)."),
      account: z.string().optional().nullable().describe("Google account: personal | a name added with /login google add (e.g. turicks, naggar if signed in). Default: personal."),
    }),
  },
);
