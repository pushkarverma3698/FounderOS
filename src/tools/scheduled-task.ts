/**
 * FounderOS — Scheduled Agent Task Tool
 * ======================================
 * Persists a founder-approved future task into the scheduled_tasks queue. A
 * zero-LLM cron sweep (src/infra/scheduler.ts) fires it at its time as a
 * normal kernel turn on the founder's thread — HITL gating, receipts and
 * budget caps apply at fire time exactly as for a typed message.
 *
 * This tool ONLY validates + persists. The HITL approval card lives in the
 * agent-tool wrapper (agent-tools/scheduling.ts), matching the
 * scheduled-post.ts ↔ comms.ts split. Approval happens once, at schedule time;
 * external actions inside the fired turn still raise their own cards.
 *
 * A task runs once (`scheduled_at`) or repeats (`recurrence`, a spec string, never
 * both). A repeating task's first run is the rule's next occurrence; each run books
 * the one after it (src/infra/task-recurrence.ts).
 */

import { childLogger } from "../infra/logger.js";
import { insertScheduledTask } from "../db/queries.js";
import { describeRecurrence, nextRecurrence, parseRecurrence } from "../core/time.js";
import type { UnifiedTool, ToolResult } from "./index.js";

const log = childLogger({ module: "tool:scheduled-task" });

const RECURRENCE_FORMS = "daily@08:00 · weekdays@09:00 · weekly@mon:09:00 · monthly@01:09:00 (24h, founder's timezone)";

/** One run at a future instant, or a repeat rule whose next occurrence is the first run. Never both. */
function resolveTiming(
  scheduledAt: string | null | undefined,
  recurrence: string | null | undefined,
): { when: Date; spec: string | null } | { error: string } {
  const spec = recurrence?.trim() || null;
  const at = scheduledAt?.trim() || null;
  if (spec && at) return { error: "Give scheduled_at for one run or recurrence for a repeating task, not both." };
  if (!spec && !at) return { error: "Give scheduled_at (one run) or recurrence (repeating task)." };

  if (spec) {
    const rec = parseRecurrence(spec);
    if (!rec) return { error: `recurrence '${spec}' is not a rule I can read. Use one of: ${RECURRENCE_FORMS}.` };
    return { when: nextRecurrence(rec, new Date()), spec };
  }

  const when = new Date(at!);
  if (Number.isNaN(when.getTime())) return { error: `scheduled_at '${at}' is not a valid ISO datetime.` };
  if (when.getTime() <= Date.now()) return { error: "scheduled_at must be in the future." };
  return { when, spec: null };
}

export const scheduleTaskTool: UnifiedTool = {
  name: "schedule_task",
  description:
    "Queue an agent task to run automatically at a future time (server-side scheduling). " +
    "At fire time it runs as a normal kernel turn on the founder's thread. Idempotency-checked.",
  input_schema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "What to do when the task fires — a normal turn input." },
      scheduled_at: { type: "string", description: "ISO 8601 datetime to fire at once (must be future). Omit when recurrence is given." },
      recurrence: { type: "string", description: `Repeat rule instead of a time: ${RECURRENCE_FORMS}.` },
      chat_id: { type: "string", description: "Chat whose thread the turn runs on." },
      idempotency_key: { type: "string", description: "Time-invariant dedup key." },
      tenant_id: { type: "string", description: "Tenant identifier." },
    },
    required: ["prompt", "chat_id", "idempotency_key", "tenant_id"],
  },

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const { prompt, scheduled_at, recurrence, chat_id, idempotency_key, tenant_id } = input as {
      prompt: string;
      scheduled_at?: string | null;
      recurrence?: string | null;
      chat_id: string;
      idempotency_key: string;
      tenant_id: string;
    };

    if (!prompt?.trim()) {
      return { success: false, error: "prompt must be a non-empty task description." };
    }

    const timing = resolveTiming(scheduled_at, recurrence);
    if ("error" in timing) return { success: false, error: timing.error };
    const { when, spec } = timing;

    const row = await insertScheduledTask({
      tenant_id,
      prompt: prompt.trim(),
      chat_id,
      scheduled_at: when,
      recurrence: spec,
      idempotency_key,
    });

    log.info({ id: row.id, scheduled_at: when.toISOString() }, "Agent task scheduled");
    return {
      success: true,
      data: {
        scheduled_task_id: row.id,
        scheduled_at: when.toISOString(),
        status: row.status,
        recurrence: spec ? describeRecurrence(parseRecurrence(spec)!) : null,
      },
    };
  },
};
