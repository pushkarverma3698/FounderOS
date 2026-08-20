/**
 * FounderOS v3 — scheduled-task runner (gateway).
 * ================================================
 * Fires one due scheduled_tasks row as a NORMAL kernel turn on the founder's
 * own thread — same lock, gates, timeout, budget callback, HITL card path and
 * failure fold as a typed Telegram message, minus the cosmetic progress
 * placeholder. Lives in gateway (not infra) because it needs the kernel and
 * the bot API; the infra sweep receives it by injection from src/index.ts so
 * the import direction (R1) holds.
 *
 * Gate semantics: halt / daily-budget do NOT consume the task — it is released
 * back to 'scheduled' a little later, bounded by the claim counter, so a
 * founder-scheduled task can neither vanish silently nor zombie forever.
 */

import { TENANT, env, DAILY_BUDGET_USD, OFFICE_TURN_TIMEOUT_MS, OFFICE_RECURSION_LIMIT } from "../core/config.js";
import { withTurnTimeout } from "./turn-timeout.js";
import { getKernel } from "./kernel-boot.js";
import { kernelReply, getPendingKernelApproval } from "../kernel/index.js";
import type { ApprovalRequest } from "../infra/hitl.js";
import { formatApprovalCard, safeHtml } from "./approval-card.js";
import { markdownToTelegramHtml, splitForTelegram } from "./format.js";
import {
  getTodayCostUsd,
  markScheduledTaskDone,
  markScheduledTaskFailed,
  releaseScheduledTask,
  reclaimStrandedScheduledTasks,
} from "../db/queries.js";
import { BudgetGuardCallback, createRunBudget } from "../infra/budget.js";
import { assertDailyBudgetAllowsRun, DailyBudgetExceededError } from "../infra/daily-budget.js";
import { readHalt } from "../infra/halt.js";
import { startTurn } from "../infra/trace.js";
import { TraceCallback } from "../infra/trace-callback.js";
import { kernelPromptHash } from "./prompt-version.js";
import { logger } from "../infra/logger.js";
import { withChatTurnLock, threadIdFor, kernelCostSink } from "./kernel-run.js";
import { recordFailedTurnInHistory } from "./failed-turn-fold.js";
import { getBot } from "./telegram.js";
import type { ScheduledTask } from "../db/schema.js";

const log = logger.child({ module: "scheduled-task-run" });

/** Claim counter ceiling — after this many halt/budget deferrals the task fails loud. */
export const MAX_TASK_ATTEMPTS = 5;
/** How far a gated task is pushed back before its next attempt. */
export const TASK_DEFER_MS = 15 * 60 * 1000;

async function notifyChat(chatId: string, html: string): Promise<void> {
  await getBot()
    .api.sendMessage(chatId, html, { parse_mode: "HTML" })
    .catch((err) => log.warn({ err: String(err) }, "Scheduled-task notify failed")); // allow-failopen: a notify blip must not kill the sweep; the DB row already records the state
}

/** Defer a gated task (release back to 'scheduled'), or fail loud past the attempt cap. */
async function deferOrFail(task: ScheduledTask, reason: string): Promise<void> {
  if (task.attempts >= MAX_TASK_ATTEMPTS) {
    const msg = `gave up after ${MAX_TASK_ATTEMPTS} deferrals — last gate: ${reason}`;
    await markScheduledTaskFailed(task.id, msg);
    await notifyChat(task.chat_id, `❌ <b>Scheduled task dropped</b> (${safeHtml(reason)}, ${MAX_TASK_ATTEMPTS} attempts)\n<code>${safeHtml(task.prompt.slice(0, 200))}</code>`);
    return;
  }
  log.info({ id: task.id, reason, attempts: task.attempts }, "Scheduled task deferred by gate");
  await releaseScheduledTask(task.id, new Date(Date.now() + TASK_DEFER_MS));
}

/** Collect the final state from a values-mode kernel stream (no progress UI). */
async function collectFinalState(streamPromise: Promise<AsyncIterable<unknown>>): Promise<unknown> {
  let last: unknown;
  for await (const state of await streamPromise) last = state;
  if (last === undefined) {
    throw new Error("kernel.stream produced no state — this should be unreachable (graph always yields at least once)");
  }
  return last;
}

/**
 * Boot-time crash recovery for the task queue. A row the crash caught in
 * 'running' can never re-fire on its own (the claim moved it out of the
 * sweep's WHERE clause), so the founder's task would vanish silently — the
 * one failure mode this system forbids. The single-instance lock guarantees
 * no other process is mid-fire at boot, so every 'running' row is stranded:
 * requeue it (due now) under the attempt cap, fail it LOUD past the cap.
 * DB state is settled before any Telegram send, so a notify blip cannot
 * un-recover a task. Called once from src/index.ts before the sweep starts.
 */
export async function recoverStrandedScheduledTasks(): Promise<void> {
  const { requeued, failed } = await reclaimStrandedScheduledTasks(TENANT, MAX_TASK_ATTEMPTS);
  if (requeued.length === 0 && failed.length === 0) return;
  log.warn(
    { requeued: requeued.map((t) => t.id), failed: failed.map((t) => t.id) },
    "Reclaimed scheduled tasks stranded in 'running' by a crash/restart",
  );
  for (const task of failed) {
    await notifyChat(
      task.chat_id,
      `❌ <b>Scheduled task dropped</b> — a crash caught it mid-run and it hit the ${MAX_TASK_ATTEMPTS}-attempt cap. Re-schedule it if still needed.\n<code>${safeHtml(task.prompt.slice(0, 200))}</code>`,
    );
  }
  for (const task of requeued) {
    await notifyChat(
      task.chat_id,
      `🔁 <b>Scheduled task re-queued after the restart</b> — it was mid-run when the process stopped and will fire again within a minute.\n<code>${safeHtml(task.prompt.slice(0, 200))}</code>`,
    );
  }
}

/** Fire one claimed task as a kernel turn. Injected into the infra sweep by src/index.ts. */
export async function runDueScheduledTask(task: ScheduledTask): Promise<void> {
  const chatId = task.chat_id;
  await withChatTurnLock(chatId, async () => {
    const halt = await readHalt();
    if (halt) {
      await deferOrFail(task, "system halted");
      return;
    }
    try {
      await assertDailyBudgetAllowsRun(
        () => getTodayCostUsd(TENANT),
        DAILY_BUDGET_USD,
        (msg) => log.warn({ chatId, err: msg }, "Daily budget check skipped — fail-open"),
      );
    } catch (err) {
      if (err instanceof DailyBudgetExceededError) {
        await deferOrFail(task, "daily budget cap");
        return;
      }
      throw err;
    }

    const trace = startTurn({ chatId, kind: "scheduled", promptHash: kernelPromptHash() });
    const kernel = await getKernel();
    const config = {
      configurable: { thread_id: threadIdFor(chatId) },
      recursionLimit: OFFICE_RECURSION_LIMIT,
      callbacks: [
        new BudgetGuardCallback(createRunBudget(), process.env["AGENT_MODEL"] ?? "", kernelCostSink),
        new TraceCallback(trace),
      ],
    };

    try {
      await notifyChat(chatId, `⏰ <b>Scheduled task running</b>\n<code>${safeHtml(task.prompt.slice(0, 300))}</code>`);
      trace.event("turn.in", { textPreview: task.prompt.slice(0, 120), scheduledTaskId: task.id });

      // On deadline the run is ABORTED, not abandoned — the signal goes only to
      // stream() so the post-timeout fold/getState still work on a clean config.
      const abort = new AbortController();
      const res = await withTurnTimeout(
        collectFinalState(
          kernel.stream(
            {
              turn: {
                id: trace.turnId,
                chat_id: chatId,
                received_at: new Date().toISOString(),
                raw_input: task.prompt,
              },
            },
            { ...config, streamMode: "values", signal: abort.signal },
          ) as Promise<AsyncIterable<unknown>>,
        ),
        OFFICE_TURN_TIMEOUT_MS,
        "kernel.scheduled",
        () => abort.abort(),
      );

      // The turn itself is done either way — a pending approval is the founder's
      // decision now, exactly like a typed message that raised a card.
      const approval = (await getPendingKernelApproval(kernel, config)) as ApprovalRequest | null;
      if (approval) {
        trace.event("hitl.interrupt", { title: approval.title });
        const card = formatApprovalCard(approval);
        await getBot().api.sendMessage(chatId, card.html, { parse_mode: "HTML", reply_markup: card.keyboard });
        await markScheduledTaskDone(task.id);
        return;
      }

      const reply = kernelReply(res as never);
      trace.event("turn.out", { replyPreview: reply.slice(0, 200) });
      const html = markdownToTelegramHtml(reply);
      for (const chunk of splitForTelegram(html)) {
        await getBot()
          .api.sendMessage(chatId, chunk, { parse_mode: "HTML" })
          .catch(async () => {
            // Telegram rejected the HTML (edge-case entities) — send plain, never drop.
            await getBot().api.sendMessage(chatId, reply.slice(0, 4000));
          });
      }
      await markScheduledTaskDone(task.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      trace.event("turn.error", { message: message.slice(0, 400) });
      // Same fold as a live turn: the failure must be visible to the NEXT turn's planner.
      await recordFailedTurnInHistory(kernel, config, err);
      await markScheduledTaskFailed(task.id, message);
      await notifyChat(chatId, `❌ <b>Scheduled task failed</b>\n<code>${safeHtml(message.slice(0, 500))}</code>`);
    }
  });
}
