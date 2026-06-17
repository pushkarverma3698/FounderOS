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
import { assertBootConfigOrThrow } from "./infra/boot-validate.js";
import { env } from "./core/config.js";
import { closeDatabaseConnections } from "./db/client.js";
import { getOffice } from "./agents/office.js";
import { startBot, stopBot, sendToChat } from "./gateway/telegram.js";
import { restorePendingApprovalAfterRestart } from "./gateway/office-run.js";
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

  // 1c. Strict boot validation — FAIL LOUD before compiling the office if a
  //     fatal misconfig would make the bot silently half-dead (dead LLM provider,
  //     no DB, no Telegram transport). Converts a production-only failure into an
  //     immediate startup error (CLAUDE.md rule #19.5).
  const bootValidation = assertBootConfigOrThrow(env);
  for (const w of bootValidation.warnings) log.warn({ module: "boot" }, `[boot] ${w}`);

  // 1d. Provider smoke — verify Composio/gws reachability at boot (warn only).
  if (shouldRunProviderSmoke()) {
    await runProviderSmokeAtBoot().catch((err) => {
      log.warn({ err: (err as Error).message }, "Provider smoke failed — non-fatal");
    });
  }

  // 2. Compile the office once (warms the Postgres checkpointer).
  await getOffice();
  log.info("Office ready (supervisor + 7 departments)");

  // 3. Health/metrics + web gateway (JARVIS API at /api/v1/*).
  healthServer = startHealthServer();
  log.info("Web gateway ready — JARVIS API at /api/v1/* (same port as /health)");

  // 4. Telegram bot (long polling — runs in background).
  await startBot();

  // 4b. Crash recovery — expire DB rows, clear ancient checkpoints, re-post recent HITL.
  await expireStaleInterrupts().catch((err) => {
    log.warn({ err: (err as Error).message }, "expireStaleInterrupts failed — non-fatal");
  });
  const restored = await restorePendingApprovalAfterRestart(env.TELEGRAM_CHAT_ID).catch((err) => {
    log.warn({ err: (err as Error).message }, "Pending HITL restore failed — non-fatal");
    return false;
  });
  if (restored) {
    log.info("Restored pending HITL approval card after restart");
  }

  // 5. Proactive scheduler (Monday brief + stale approval reminders).
  startScheduler();

  // 6. Startup notification — let the founder know the bot is alive.
  await sendToChat(buildRestartMessage(), "HTML").catch((err) =>
    log.warn({ err: (err as Error).message }, "Startup notification failed — bot token may not be ready yet"),
  );

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
