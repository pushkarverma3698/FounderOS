/**
 * FounderOS — Reminder Tool
 * =========================
 * Persists a founder reminder into the `reminders` queue. A zero-LLM cron sweep
 * (src/infra/scheduler.ts) pings the founder at its time with NO kernel turn — a
 * reminder never executes anything, it only nudges. Because it has no side
 * effect and no cost, setting one needs NO HITL approval (unlike schedule_task).
 *
 * This tool ONLY validates + persists. Exactly one of `remind_at` (one-shot ISO)
 * or `recurrence` (a simple repeat rule) must be given; for a recurrence the
 * first fire time is computed here from the current clock.
 */

import { childLogger } from "../infra/logger.js";
import { insertReminder } from "../db/queries.js";
import { nextRecurrence, appTimeZone, type Recurrence } from "../core/time.js";
import type { UnifiedTool, ToolResult } from "./index.js";

const log = childLogger({ module: "tool:reminder" });

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Validate the structured recurrence rule; returns an error string or null. */
export function validateRecurrence(rec: unknown): string | null {
  if (typeof rec !== "object" || rec === null) return "recurrence must be an object.";
  const r = rec as Record<string, unknown>;
  if (typeof r["time"] !== "string" || !TIME_RE.test(r["time"])) {
    return "recurrence.time must be 'HH:MM' (24h).";
  }
  if (r["kind"] === "daily" || r["kind"] === "weekdays") return null;
  if (r["kind"] === "weekly") {
    const wd = r["weekday"];
    if (typeof wd !== "number" || wd < 0 || wd > 6) return "recurrence.weekday must be 0 (Sun)–6 (Sat).";
    return null;
  }
  return "recurrence.kind must be 'daily', 'weekdays', or 'weekly'.";
}

export const setReminderTool: UnifiedTool = {
  name: "set_reminder",
  description:
    "Persist a founder reminder (a pure ping — never executes anything). Give exactly one of " +
    "remind_at (ISO 8601, one-shot) or recurrence (a repeat rule). Idempotency-checked.",
  input_schema: {
    type: "object",
    properties: {
      text: { type: "string", description: "The nudge shown to the founder at fire time." },
      remind_at: { type: "string", description: "One-shot: ISO 8601 datetime to ping at (must be future)." },
      recurrence: {
        type: "object",
        description: "Repeat rule: { kind:'daily'|'weekdays'|'weekly', time:'HH:MM', weekday?:0-6 }.",
      },
      chat_id: { type: "string", description: "Chat to ping." },
      idempotency_key: { type: "string", description: "Time-invariant dedup key." },
      tenant_id: { type: "string", description: "Tenant identifier." },
      timezone: { type: "string", description: "IANA zone (defaults to the app timezone)." },
    },
    required: ["text", "chat_id", "idempotency_key", "tenant_id"],
  },

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const text = typeof input["text"] === "string" ? input["text"].trim() : "";
    const remindAtRaw = input["remind_at"] as string | undefined;
    const recurrenceRaw = input["recurrence"] as unknown;
    const chat_id = input["chat_id"] as string;
    const idempotency_key = input["idempotency_key"] as string;
    const tenant_id = input["tenant_id"] as string;
    const timezone = (input["timezone"] as string | undefined) ?? appTimeZone();

    if (!text) return { success: false, error: "text must be a non-empty reminder." };

    const hasOneShot = typeof remindAtRaw === "string" && remindAtRaw.length > 0;
    const hasRecurrence = recurrenceRaw != null;
    if (hasOneShot === hasRecurrence) {
      return { success: false, error: "Provide exactly one of remind_at (one-shot) or recurrence (repeat)." };
    }

    let remind_at: Date;
    let recurrence: Recurrence | null = null;

    if (hasOneShot) {
      remind_at = new Date(remindAtRaw!);
      if (Number.isNaN(remind_at.getTime())) {
        return { success: false, error: `remind_at '${remindAtRaw}' is not a valid ISO datetime.` };
      }
      if (remind_at.getTime() <= Date.now()) {
        return { success: false, error: "remind_at must be in the future." };
      }
    } else {
      const invalid = validateRecurrence(recurrenceRaw);
      if (invalid) return { success: false, error: invalid };
      recurrence = recurrenceRaw as Recurrence;
      remind_at = nextRecurrence(recurrence, new Date(), timezone);
    }

    const row = await insertReminder({ tenant_id, chat_id, text, remind_at, recurrence, timezone, idempotency_key });

    log.info({ id: row.id, remind_at: remind_at.toISOString(), recurring: hasRecurrence }, "Reminder set");
    return {
      success: true,
      data: { reminder_id: row.id, remind_at: remind_at.toISOString(), recurring: hasRecurrence, status: row.status },
    };
  },
};
