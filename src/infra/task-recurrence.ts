/**
 * FounderOS — recurring scheduled tasks
 * =====================================
 * A scheduled_tasks row with a `recurrence` spec (`daily@08:00`, `weekdays@09:00`,
 * `weekly@mon:09:00`, `monthly@01:09:00`) books its next occurrence as a FRESH row.
 *
 * WHEN: at claim time, before the task runs, not on completion. A halt, a budget
 * deferral, a turn that throws or a process crash would each end a chain that
 * re-armed on completion, and a daily task that silently stops is the failure the
 * founder cannot see. Booked first, today's outcome cannot touch tomorrow's run.
 *
 * ONCE: the child's idempotency key is `recur:<parent id>`, and insertScheduledTask
 * is ON CONFLICT DO NOTHING on that key. A deferred row is claimed again later and
 * calls this again; the second call returns the child the first one booked.
 *
 * STOPPING: cancelling the upcoming row (edit_scheduled) ends the chain, because
 * only a row that fires books a successor.
 */

import { insertScheduledTask } from "../db/queries.js";
import { nextRecurrence, parseRecurrence } from "../core/time.js";
import type { ScheduledTask } from "../db/schema.js";

/** The idempotency key of the occurrence a row books. One child per parent, ever. */
export function nextOccurrenceKey(parentId: string): string {
  return `recur:${parentId}`;
}

/**
 * Book the next occurrence of a recurring task. Returns null for a one-shot task.
 * Throws when the stored spec does not parse: the caller tells the founder, because a
 * repeat rule that quietly stops repeating is worse than a loud one.
 */
export async function bookNextOccurrence(task: ScheduledTask, now: Date = new Date()): Promise<ScheduledTask | null> {
  if (!task.recurrence) return null;
  const rec = parseRecurrence(task.recurrence);
  if (!rec) throw new Error(`its repeat rule "${task.recurrence}" is not one I can read`);
  return insertScheduledTask({
    tenant_id: task.tenant_id,
    prompt: task.prompt,
    chat_id: task.chat_id,
    scheduled_at: nextRecurrence(rec, now),
    recurrence: task.recurrence,
    idempotency_key: nextOccurrenceKey(task.id),
  });
}
