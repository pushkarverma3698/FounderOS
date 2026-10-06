/**
 * Scheduling tools (admin worker).
 *   schedule_task   — WRITE (HITL-gated): queue a future kernel turn
 *   list_scheduled  — read-only: everything queued (tasks + posts + fixed crons)
 *   edit_scheduled  — cancel / reschedule a queued task or post
 *
 * The queue itself performs no side effects: a fired task runs as a normal
 * kernel turn, so any external action inside it still raises its own HITL card.
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { TENANT, env } from "../../core/config.js";
import { resolveTiming, scheduleTaskTool } from "../../tools/scheduled-task.js";
import { describeRecurrence, parseRecurrence } from "../../core/time.js";
import {
  listUpcomingScheduledTasks,
  listUpcomingScheduledPosts,
  cancelScheduledTask,
  rescheduleScheduledTask,
  cancelScheduledPost,
  rescheduleScheduledPost,
} from "../../db/queries.js";
import { childLogger } from "../../infra/logger.js";
import { hitlGate, idemKey } from "./hitl.js";
import { chatIdFromThreadId } from "../../infra/telegram-send.js";

const log = childLogger({ module: "agent-tools:scheduling" });

function fmtWhen(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

/** " (repeats every day at 08:00)" for a recurring row, "" for a one-shot. */
function repeatLabel(spec: string | null): string {
  const rule = spec ? parseRecurrence(spec) : null;
  return rule ? ` (repeats ${describeRecurrence(rule)}; cancel this run to stop it)` : "";
}

/** Parse an ISO datetime that must be in the future; returns null with no throw. */
function parseFutureTime(raw: string): Date | null {
  const when = new Date(raw);
  if (Number.isNaN(when.getTime()) || when.getTime() <= Date.now()) return null;
  return when;
}

/** Schedule a future agent task — founder approves once, at schedule time. */
export const scheduleTask = tool(
  async ({ prompt, scheduled_at, recurrence }, config) => {
    // Before the card: a timing the tool cannot run must never reach the founder as an approval ("Runs at undefined").
    const timing = resolveTiming(scheduled_at, recurrence);
    if ("error" in timing) return `Task scheduling failed: ${timing.error}`;
    const rule = timing.spec ? parseRecurrence(timing.spec) : null;
    const rejected = await hitlGate(
      {
        action: "schedule_task",
        title: rule ? "🔁 Schedule this repeating task?" : "⏰ Schedule this task?",
        summary: rule ? `Runs ${describeRecurrence(rule)}, until you cancel it` : `Runs at ${scheduled_at}`,
        preview: prompt,
        args: { prompt, scheduled_at, recurrence },
      },
      config,
    );
    if (rejected) return rejected;

    const res = await scheduleTaskTool.execute({
      prompt,
      scheduled_at,
      recurrence,
      // The chat that asked: the fired turn runs on, and reports to, that chat (the family group, not the DM).
      chat_id: chatIdFromThreadId(config?.configurable?.["thread_id"]) ?? env.TELEGRAM_CHAT_ID,
      // Deterministic key so an interrupt() resume never schedules twice.
      idempotency_key: idemKey("schedtask", prompt, scheduled_at ?? `every:${recurrence ?? ""}`),
      tenant_id: TENANT,
    });

    if (!res.success) return `Task scheduling failed: ${res.error}`;
    const data = res.data as { scheduled_task_id: string; scheduled_at: string; recurrence: string | null };
    log.info({ id: data.scheduled_task_id, at: data.scheduled_at, recurrence: data.recurrence }, "Task scheduled via agent");
    return data.recurrence
      ? `✅ Repeating task set: ${data.recurrence}. First run ${data.scheduled_at} (id: ${data.scheduled_task_id}). Each run reports back here; cancel the upcoming run to stop it.`
      : `✅ Task scheduled for ${data.scheduled_at} (id: ${data.scheduled_task_id}). It will run automatically and report back here.`;
  },
  {
    name: "schedule_task",
    description:
      "Schedule an agent task to run automatically, once (scheduled_at) or repeating (recurrence). The founder " +
      "APPROVES once now; at each fire time the task runs as a normal turn (any external action inside it still asks " +
      "for approval). Provide the full task instruction and exactly one of scheduled_at or recurrence.",
    schema: z.object({
      prompt: z.string().describe("The full task instruction to execute when the time arrives"),
      scheduled_at: z
        .string()
        .optional()
        .nullable()
        .describe("One run: ISO 8601 datetime, e.g. 2026-07-13T09:00:00+02:00 (must be future)"),
      recurrence: z
        .string()
        .optional()
        .nullable()
        .describe(
          "Repeating: daily@08:00 | weekdays@09:00 | weekly@mon:09:00 | monthly@01:09:00 (24h, founder's timezone). " +
            "Never cron or RRULE text.",
        ),
    }),
  },
);

/** Everything scheduled — agent tasks, social posts, and the fixed maintenance crons. */
export const listScheduled = tool(
  async () => {
    const [tasks, posts] = await Promise.all([
      listUpcomingScheduledTasks(TENANT),
      listUpcomingScheduledPosts(TENANT),
    ]);

    const taskLines = tasks.length
      ? tasks.map(
          (t, i) =>
            `${i + 1}. ${fmtWhen(t.scheduled_at)}${repeatLabel(t.recurrence)} — "${t.prompt.slice(0, 80)}${t.prompt.length > 80 ? "…" : ""}" (task id: ${t.id})`,
        )
      : ["(none)"];
    const postLines = posts.length
      ? posts.map(
          (p, i) =>
            `${i + 1}. ${fmtWhen(p.scheduled_at)} — "${p.text.slice(0, 60)}${p.text.length > 60 ? "…" : ""}"${p.mention_name ? ` @${p.mention_name}` : ""} (post id: ${p.id})`,
        )
      : ["(none)"];

    return [
      "⏰ Scheduled agent tasks:",
      ...taskLines,
      "",
      "📅 Scheduled social posts:",
      ...postLines,
      "",
      "🔧 Fixed maintenance crons (code-defined, not editable here): stale-approval reminder (daily 9:00), " +
        "budget alerts (hourly), brain sync (daily 2:00), checkpoint sweep (daily 3:30), " +
        "scheduled post/task sweeps (every minute).",
    ].join("\n");
  },
  {
    name: "list_scheduled",
    description:
      "List everything scheduled: upcoming agent tasks, queued social posts (with ids for editing), " +
      "and the fixed maintenance crons. Read-only — no approval needed.",
    schema: z.object({}),
  },
);

/** Cancel or reschedule a queued task/post. Only 'scheduled' rows can be edited. */
export const editScheduled = tool(
  async ({ kind, id, action, new_time }) => {
    if (action === "reschedule") {
      const when = new_time ? parseFutureTime(new_time) : null;
      if (!when) return "Reschedule needs new_time as a future ISO 8601 datetime.";
      const row =
        kind === "task" ? await rescheduleScheduledTask(id, when) : await rescheduleScheduledPost(id, when);
      if (!row) return `No editable ${kind} with id ${id} — it may already have run, failed, or been canceled. Use list_scheduled for current ids.`;
      log.info({ kind, id, at: when.toISOString() }, "Scheduled item rescheduled via agent");
      return `✅ ${kind === "task" ? "Task" : "Post"} ${id} moved to ${when.toISOString()}.`;
    }

    const row = kind === "task" ? await cancelScheduledTask(id) : await cancelScheduledPost(id);
    if (!row) return `No editable ${kind} with id ${id} — it may already have run, failed, or been canceled. Use list_scheduled for current ids.`;
    log.info({ kind, id }, "Scheduled item canceled via agent");
    return `✅ ${kind === "task" ? "Task" : "Post"} ${id} canceled.`;
  },
  {
    name: "edit_scheduled",
    description:
      "Cancel or reschedule a queued agent task or social post. Get the id from list_scheduled first. " +
      "Canceling prevents the run/publish; rescheduling only moves the time (content is unchanged).",
    schema: z.object({
      kind: z.enum(["task", "post"]).describe("What to edit: an agent task or a social post"),
      id: z.string().describe("The id shown by list_scheduled"),
      action: z.enum(["cancel", "reschedule"]).describe("cancel = never run; reschedule = move to new_time"),
      new_time: z
        .string()
        .optional()
        .nullable()
        .describe("Required for reschedule: new ISO 8601 datetime (must be future)"),
    }),
  },
);
