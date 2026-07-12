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
 */

import { childLogger } from "../infra/logger.js";
import { insertScheduledTask } from "../db/queries.js";
import type { UnifiedTool, ToolResult } from "./index.js";

const log = childLogger({ module: "tool:scheduled-task" });

export const scheduleTaskTool: UnifiedTool = {
  name: "schedule_task",
  description:
    "Queue an agent task to run automatically at a future time (server-side scheduling). " +
    "At fire time it runs as a normal kernel turn on the founder's thread. Idempotency-checked.",
  input_schema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "What to do when the task fires — a normal turn input." },
      scheduled_at: { type: "string", description: "ISO 8601 datetime to fire at (must be future)." },
      chat_id: { type: "string", description: "Chat whose thread the turn runs on." },
      idempotency_key: { type: "string", description: "Time-invariant dedup key." },
      tenant_id: { type: "string", description: "Tenant identifier." },
    },
    required: ["prompt", "scheduled_at", "chat_id", "idempotency_key", "tenant_id"],
  },

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const { prompt, scheduled_at, chat_id, idempotency_key, tenant_id } = input as {
      prompt: string;
      scheduled_at: string;
      chat_id: string;
      idempotency_key: string;
      tenant_id: string;
    };

    if (!prompt?.trim()) {
      return { success: false, error: "prompt must be a non-empty task description." };
    }

    const when = new Date(scheduled_at);
    if (Number.isNaN(when.getTime())) {
      return { success: false, error: `scheduled_at '${scheduled_at}' is not a valid ISO datetime.` };
    }
    if (when.getTime() <= Date.now()) {
      return { success: false, error: "scheduled_at must be in the future." };
    }

    const row = await insertScheduledTask({
      tenant_id,
      prompt: prompt.trim(),
      chat_id,
      scheduled_at: when,
      idempotency_key,
    });

    log.info({ id: row.id, scheduled_at: when.toISOString() }, "Agent task scheduled");
    return {
      success: true,
      data: {
        scheduled_task_id: row.id,
        scheduled_at: when.toISOString(),
        status: row.status,
      },
    };
  },
};
