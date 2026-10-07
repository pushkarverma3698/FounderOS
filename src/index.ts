/**
 * FounderOS v3 — Entry Point
 * ===========================
 * Startup sequence:
 *  1. Single-instance lock (one long-poller, ever)
 *  2. Telemetry + boot report + strict boot validation
 *  3. Compile the kernel (planner + pure supervisor + workers, Postgres checkpointer)
 *  4. Health server + Telegram bot
 *  5. Crash recovery (expire stale approvals, re-post a recent pending card)
 *  6. Maintenance scheduler
 */

import { InlineKeyboard } from "grammy";
import { initTelemetry } from "./infra/telemetry.js";
import { logBootReport } from "./infra/boot-report.js";
import { assertBootConfigOrThrow } from "./infra/boot-validate.js";
import { env, TELEGRAM_POLLING_ENABLED } from "./core/config.js";
import { closeDatabaseConnections } from "./db/client.js";
import { getKernel } from "./gateway/kernel-boot.js";
import { startBot, stopBot, sendToChat, getBot } from "./gateway/telegram.js";
import { DRAIN_TIMEOUT_MS, drainInFlight, notifyDroppedTurns, recordDroppedTurns } from "./gateway/inflight-turns.js";
import { restorePendingApproval } from "./gateway/kernel-run.js";
import { startMergeDigestCron } from "./gateway/merge-digest-run.js";
import { resumeInterruptedMission } from "./gateway/mission-resume.js";
import { runDueScheduledTask, recoverStrandedScheduledTasks } from "./gateway/scheduled-task-run.js";
import { expireStaleInterrupts } from "./db/queries.js";
import { startClaudeLoginExpiryCron } from "./infra/claude-login-expiry.js";
import { startHealthServer } from "./infra/health.js";
import { runProviderSmokeAtBoot } from "./infra/provider-probes.js";
import { shouldRunProviderSmoke } from "./infra/provider-config.js";
import { startScheduler, recoverStrandedReminders } from "./infra/scheduler.js";
import { runGoalStandupCatchUp } from "./goals/standup-schedule.js";
import { buildRestartMessage } from "./gateway/capability-message.js";
import { sendBootNoticeOnce } from "./infra/boot-notice.js";
import { sendToChat as sendInfraChat } from "./infra/telegram-send.js"; // the boot probe runs before the bot starts, as provider-probes always did
import { acquireSingleInstanceLock, releaseSingleInstanceLock, waitForProcessExit } from "./infra/single-instance.js";
import { logger } from "./infra/logger.js";
import { installScreenCapture } from "./infra/screen-log.js";
import type { Server } from "node:http";

const log = logger.child({ module: "main" });

let healthServer: Server | undefined;

async function main(): Promise<void> {
  log.info("FounderOS v3 starting…");

  const { replacedPid } = acquireSingleInstanceLock();
  if (replacedPid !== null) {
    log.warn({ replacedPid }, "Terminated a previous FounderOS instance before starting");
    await waitForProcessExit(replacedPid);
  }

  initTelemetry();
  logBootReport(env);
  const bootValidation = assertBootConfigOrThrow(env);
  for (const w of bootValidation.warnings) log.warn({ module: "boot" }, `[boot] ${w}`);

  if (shouldRunProviderSmoke()) {
    await runProviderSmokeAtBoot((html) =>
      sendBootNoticeOnce("provider-auth", html, (text) => sendInfraChat(text, "HTML")).then(() => undefined),
    ).catch((err) => {
      log.warn({ err: (err as Error).message }, "Provider smoke failed — non-fatal");
    });
  }

  await getKernel();
  log.info("Kernel ready (planner + pure supervisor + 8 workers + synthesizer)");

  healthServer = startHealthServer();

  // Command output, HITL cards and tool sends go to the screen log the planner reads (infra/screen-log.ts).
  installScreenCapture(getBot().api, "bot");

  if (TELEGRAM_POLLING_ENABLED) {
    await startBot();
    startClaudeLoginExpiryCron(); // daily 10:15; warns 3 days before the server's Claude login stops renewing
  } else {
    log.info("Telegram polling disabled (TELEGRAM_POLLING_ENABLED=false)");
  }

  // Crash recovery — expire stale DB approvals, re-post a recent pending card.
  await expireStaleInterrupts().catch((err) => {
    log.warn({ err: (err as Error).message }, "expireStaleInterrupts failed — non-fatal");
  });
  const restored = await restorePendingApproval(env.TELEGRAM_CHAT_ID, async (text: string, keyboard: InlineKeyboard) => {
    await getBot().api.sendMessage(env.TELEGRAM_CHAT_ID, text, { parse_mode: "HTML", reply_markup: keyboard });
  }).catch((err) => {
    log.warn({ err: (err as Error).message }, "Pending HITL restore failed — non-fatal");
    return false;
  });
  if (restored) log.info("Restored pending HITL approval card after restart");

  // A mission the crash caught mid-node (no HITL pause, no folded failure)
  // resumes from its last valid checkpoint. Fire-and-forget: a resumed
  // mission can run for minutes and must not stall the scheduler or the bot;
  // the chat-turn lock serializes it against any new founder message.
  if (TELEGRAM_POLLING_ENABLED && !restored) {
    resumeInterruptedMission(env.TELEGRAM_CHAT_ID)
      .then((resumed) => {
        if (resumed) log.info("Resumed a mission interrupted by the restart");
      })
      .catch((err) => log.warn({ err: (err as Error).message }, "Mission resume failed — non-fatal")); // allow-failopen: boot must survive a resume blip; the checkpoint still holds the state
  }

  // A task the crash caught in 'running' can never re-fire on its own —
  // requeue or fail it loud BEFORE the sweep starts (single-instance lock
  // guarantees every 'running' row at boot is stranded, not in-flight).
  await recoverStrandedScheduledTasks().catch((err) => {
    log.warn({ err: (err as Error).message }, "Stranded-task recovery failed — non-fatal"); // allow-failopen: boot must survive a recovery blip; the rows stay visible in the DB
  });
  await recoverStrandedReminders().catch((err) => {
    log.warn({ err: (err as Error).message }, "Stranded-reminder recovery failed — non-fatal"); // allow-failopen: boot must survive a recovery blip; the rows stay visible in the DB
  });

  // Scheduled agent tasks fire via the gateway runner — injected here so the
  // infra scheduler never imports gateway (import-direction rule R1).
  startScheduler({ taskExecutor: runDueScheduledTask });
  // node-cron does not catch up a 09:00 a restart swallowed: run the goal standup once now if it is due. Never rejects.
  void runGoalStandupCatchUp();

  if (TELEGRAM_POLLING_ENABLED) {
    startMergeDigestCron(); // 19:00 list of PRs ready to merge, one Merge button each; the daemon never merges for you
    // One "send it again" per turn the last shutdown cut off (never replayed: the ask may have had a side effect).
    await notifyDroppedTurns((chatId, text) => getBot().api.sendMessage(chatId, text).then(() => undefined)).catch((err) =>
      log.warn({ err: (err as Error).message }, "Dropped-turn notice failed"), // allow-failopen: the ledger keeps the entry for the next boot
    );
    await sendBootNoticeOnce("restart", buildRestartMessage(), (text) => sendToChat(text, "HTML")).catch((err) =>
      log.warn({ err: (err as Error).message }, "Startup notification failed"),
    );
  }

  log.info("FounderOS v3 running 🚀");
}

// ── Graceful Shutdown ─────────────────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, "Shutdown signal received — draining…");
  const startedAt = Date.now();
  healthServer?.close();
  await stopBot(); // no new updates from here on
  // Wait for turns the founder is waiting on; the budget counts from SIGTERM so the unit's TimeoutStopSec still holds.
  const { drained, dropped } = await drainInFlight(DRAIN_TIMEOUT_MS - (Date.now() - startedAt));
  if (!drained) {
    log.warn({ dropped: dropped.map((t) => t.turnId) }, "Drain timed out — turns still running will be reported on the next boot");
    await recordDroppedTurns(dropped);
  }
  await closeDatabaseConnections();
  releaseSingleInstanceLock();
  log.info("FounderOS stopped cleanly");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM").catch(console.error));
process.on("SIGINT", () => shutdown("SIGINT").catch(console.error));
process.on("uncaughtException", (err) => {
  log.fatal({ err: err.message, stack: err.stack }, "Uncaught exception — shutting down");
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  log.fatal({ reason: String(reason) }, "Unhandled rejection — shutting down");
  process.exit(1);
});

main().catch((err) => {
  console.error("Startup failed:", err);
  process.exit(1);
});
