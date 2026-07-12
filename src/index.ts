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
import { restorePendingApproval } from "./gateway/kernel-run.js";
import { runDueScheduledTask } from "./gateway/scheduled-task-run.js";
import { expireStaleInterrupts } from "./db/queries.js";
import { startHealthServer } from "./infra/health.js";
import { runProviderSmokeAtBoot } from "./infra/provider-probes.js";
import { shouldRunProviderSmoke } from "./infra/provider-config.js";
import { startScheduler } from "./infra/scheduler.js";
import { buildRestartMessage } from "./gateway/capability-message.js";
import { acquireSingleInstanceLock, releaseSingleInstanceLock, waitForProcessExit } from "./infra/single-instance.js";
import { logger } from "./infra/logger.js";
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
    await runProviderSmokeAtBoot().catch((err) => {
      log.warn({ err: (err as Error).message }, "Provider smoke failed — non-fatal");
    });
  }

  await getKernel();
  log.info("Kernel ready (planner + pure supervisor + 8 workers + synthesizer)");

  healthServer = startHealthServer();

  if (TELEGRAM_POLLING_ENABLED) {
    await startBot();
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

  // Scheduled agent tasks fire via the gateway runner — injected here so the
  // infra scheduler never imports gateway (import-direction rule R1).
  startScheduler({ taskExecutor: runDueScheduledTask });

  if (TELEGRAM_POLLING_ENABLED) {
    await sendToChat(buildRestartMessage(), "HTML").catch((err) =>
      log.warn({ err: (err as Error).message }, "Startup notification failed"),
    );
  }

  log.info("FounderOS v3 running 🚀");
}

// ── Graceful Shutdown ─────────────────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, "Shutdown signal received — draining…");
  healthServer?.close();
  await stopBot();
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
