/**
 * Reminder tools (admin worker).
 *   set_reminder   — persist a pure ping (NO HITL: a self-nudge has no side effect)
 *   list_reminders — read-only: upcoming reminders, times shown in the founder's zone
 *   edit_reminder  — cancel / reschedule a still-scheduled reminder
 *
 * A reminder never executes anything — it only nudges the founder. "Snooze" is
 * just a fresh one-shot reminder the planner sets from the ping's text.
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { TENANT, env } from "../../core/config.js";
import { setReminderTool } from "../../tools/reminder.js";
import { listUpcomingReminders, cancelReminder, rescheduleReminder } from "../../db/queries.js";
import { formatInZone, describeRecurrence, appTimeZone, type Recurrence } from "../../core/time.js";
import { childLogger } from "../../infra/logger.js";
import { idemKey } from "./hitl.js";

const log = childLogger({ module: "agent-tools:reminders" });

/** Parse an ISO datetime that must be in the future; returns null with no throw. */
function parseFutureTime(raw: string): Date | null {
  const when = new Date(raw);
  if (Number.isNaN(when.getTime()) || when.getTime() <= Date.now()) return null;
  return when;
}

const recurrenceSchema = z
  .object({
    kind: z.enum(["daily", "weekdays", "weekly"]),
    time: z.string().describe("24h 'HH:MM' in the founder's timezone, e.g. '09:00'"),
    weekday: z.number().int().min(0).max(6).optional().describe("weekly only: 0=Sun..6=Sat"),
  })
  .describe("A simple repeat rule");

/** Set a reminder — pure ping, no approval needed. */
export const setReminder = tool(
  async ({ text, remind_at, recurrence }) => {
    const res = await setReminderTool.execute({
      text,
      ...(remind_at ? { remind_at } : {}),
      ...(recurrence ? { recurrence } : {}),
      chat_id: env.TELEGRAM_CHAT_ID,
      idempotency_key: idemKey("reminder", text, remind_at ?? JSON.stringify(recurrence ?? {})),
      tenant_id: TENANT,
      timezone: appTimeZone(),
    });

    if (!res.success) return `Couldn't set the reminder: ${res.error}`;
    const data = res.data as { reminder_id: string; remind_at: string; recurring: boolean };
    const when = formatInZone(new Date(data.remind_at));
    log.info({ id: data.reminder_id, at: data.remind_at, recurring: data.recurring }, "Reminder set via agent");
    return data.recurring && recurrence
      ? `✅ Recurring reminder set — ${describeRecurrence(recurrence as Recurrence)}. Next: ${when}. (id: ${data.reminder_id})`
      : `✅ Reminder set — I'll ping you ${when}. (id: ${data.reminder_id})`;
  },
  {
    name: "set_reminder",
    description:
      "Set a reminder that PINGS the founder at a time — it never executes anything, it only nudges. " +
      "Use for 'remind me …'. Give exactly one of remind_at (one-shot, ISO 8601 with the founder's UTC offset) " +
      "or recurrence (a repeat rule). No approval is needed. Resolve the time from the current-time line in your context.",
    schema: z.object({
      text: z.string().describe("The nudge to show the founder, e.g. 'call the accountant'"),
      remind_at: z
        .string()
        .optional()
        .describe("One-shot ISO 8601 datetime WITH offset, e.g. 2026-07-23T09:00:00+05:30 (must be future)"),
      recurrence: recurrenceSchema.optional(),
    }),
  },
);

/** Upcoming reminders — times rendered in the founder's zone. */
export const listReminders = tool(
  async () => {
    const rows = await listUpcomingReminders(TENANT);
    if (rows.length === 0) return "⏰ No reminders scheduled.";
    const lines = rows.map((r, i) => {
      const when = formatInZone(new Date(r.remind_at));
      const repeat = r.recurrence ? ` (${describeRecurrence(r.recurrence)})` : "";
      return `${i + 1}. ${when}${repeat} — "${r.text.slice(0, 80)}${r.text.length > 80 ? "…" : ""}" (id: ${r.id})`;
    });
    return ["⏰ Upcoming reminders:", ...lines].join("\n");
  },
  {
    name: "list_reminders",
    description: "List the founder's upcoming reminders with their times (in the founder's timezone) and ids. Read-only.",
    schema: z.object({}),
  },
);

/** Cancel or reschedule a still-scheduled reminder. */
export const editReminder = tool(
  async ({ id, action, new_time }) => {
    if (action === "reschedule") {
      const when = new_time ? parseFutureTime(new_time) : null;
      if (!when) return "Reschedule needs new_time as a future ISO 8601 datetime.";
      const row = await rescheduleReminder(id, when);
      if (!row) return `No editable reminder with id ${id} — it may have already fired or been canceled. Use list_reminders.`;
      log.info({ id, at: when.toISOString() }, "Reminder rescheduled via agent");
      return `✅ Reminder moved to ${formatInZone(when)}.`;
    }
    const row = await cancelReminder(id);
    if (!row) return `No editable reminder with id ${id} — it may have already fired or been canceled. Use list_reminders.`;
    log.info({ id }, "Reminder canceled via agent");
    return `✅ Reminder canceled.`;
  },
  {
    name: "edit_reminder",
    description:
      "Cancel or reschedule a still-scheduled reminder. Get the id from list_reminders first. " +
      "To 'snooze', instead set a new reminder from the ping's text.",
    schema: z.object({
      id: z.string().describe("The reminder id shown by list_reminders"),
      action: z.enum(["cancel", "reschedule"]).describe("cancel = never ping; reschedule = move to new_time"),
      new_time: z.string().optional().nullable().describe("Required for reschedule: future ISO 8601 datetime"),
    }),
  },
);
