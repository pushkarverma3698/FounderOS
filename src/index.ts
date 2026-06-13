/**
 * FounderOS v2 — Entry Point
 * ===========================
 * Startup sequence:
 *  1. Init telemetry (LangSmith)
 *  2. Compile the office (supervisor + sub-agents; initialises DB checkpointer)
 *  3. Start health server
 *  4. Start Telegram bot (long polling)
 *  5. Graceful shutdown handlers
 *
 * The old multi-pod graph, custom HITL registry, and cron scheduler are no
 * longer booted — the office handles routing, and HITL is native (interrupt()).
 */

import { initTelemetry } from "./infra/telemetry.js";
import { logBootReport } from "./infra/boot-report.js";
import { env } from "./core/config.js";
import { closeDatabaseConnections } from "./db/client.js";
import { getOffice } from "./agents/office.js";
import { startBot, stopBot, sendToChat } from "./gateway/telegram.js";
import { startHealthServer } from "./infra/health.js";
import { startScheduler } from "./infra/scheduler.js";
import { acquireSingleInstanceLock, releaseSingleInstanceLock, waitForProcessExit } from "./infra/single-instance.js";
import { logger } from "./infra/logger.js";
import type { Server } from "node:http";

const log = logger.child({ module: "main" });

let healthServer: Server | undefined;

async function main(): Promise<void> {
  log.info("FounderOS starting…");

  // 0. Single-instance lock — two long-polling bots cause Telegram 409 conflicts
  //    and split updates between processes (the #1 reliability bug). Replace any
  //    previous live instance so exactly one process owns getUpdates.
  const { replacedPid } = acquireSingleInstanceLock();
  if (replacedPid !== null) {
    log.warn({ replacedPid }, "Terminated a previous FounderOS instance before starting");
    // Wait until the old instance has ACTUALLY exited (SIGKILL on timeout) so it
    // has released the Telegram long-poll and the health port. A fixed sleep was
    // not enough — a slow graceful drain left the port held, the new instance
    // crashed on EADDRINUSE, and the stale old code kept running.
    await waitForProcessExit(replacedPid);
  }

  // 1. Telemetry — first, so PII scrubbing hooks in before any LLM call.
  initTelemetry();

  // 1b. Capability self-check — log LIVE/MISSING integrations so config drift
  //     is visible in journald instead of surfacing as a silent dead department.
  logBootReport(env);

  // 2. Compile the office once (warms the Postgres checkpointer).
  await getOffice();
  log.info("Office ready (supervisor + 7 departments)");

  // 3. Health/metrics server.
  healthServer = startHealthServer();

  // 4. Telegram bot (long polling — runs in background).
  await startBot();

  // 5. Proactive scheduler (Monday brief + stale approval reminders).
  startScheduler();

  // 6. Startup notification — let the founder know the bot is alive.
  await sendToChat(
    `🚀 <b>FounderOS is running</b>\n\n` +
    `Departments: research · comms · engineering · marketing · sales · personal · jobhunt\n` +
    `Commands: /status · /context · /target · /targets · /outbound\n\n` +
    `Ready for your first message.`,
    "HTML",
  ).catch((err) => log.warn({ err: (err as Error).message }, "Startup notification failed — bot token may not be ready yet"));

  log.info("FounderOS running 🚀");
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
