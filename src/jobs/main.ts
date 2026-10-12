/**
 * The standalone jobs process (2026-10-10): the only thing FounderOS still runs.
 *
 * Startup: single-instance lock, health server, the jobs bot (commands and jh: buttons),
 * then the jobs crons (sweep + daily brief, follow-ups, digest, funding grower, findings).
 * No kernel, planner or coding pipeline: the import-closure test in
 * tests/unit/jobs/jobs-entry.test.ts fails if one comes back.
 *
 * The bot speaks with JOBS_BOT_TOKEN, falling back to TELEGRAM_BOT_TOKEN; which one is
 * logged here, at boot, so a deploy that forgot the new token is visible in the journal.
 */
import type { Server } from "node:http";
import { TELEGRAM_POLLING_ENABLED } from "../core/config.js";
import { closeDatabaseConnections } from "../db/client.js";
import { resolveJobsBotToken } from "../infra/jobs-bot-token.js";
import { acquireSingleInstanceLock, releaseSingleInstanceLock, waitForProcessExit } from "../infra/single-instance.js";
import { logger } from "../infra/logger.js";
import { startJobsHealthServer } from "./health.js";
import { startJobsBot, stopJobsBot } from "./bot.js";
import { startJobsScheduler } from "./scheduler.js";

const log = logger.child({ module: "jobs-main" });

let healthServer: Server | undefined;

async function main(): Promise<void> {
  log.info("FounderOS jobs starting");
  const { replacedPid } = acquireSingleInstanceLock();
  if (replacedPid !== null) {
    log.warn({ replacedPid }, "Terminated a previous instance before starting");
    await waitForProcessExit(replacedPid);
  }

  const { source } = resolveJobsBotToken(); // throws, naming both variables, when neither is set
  log.info({ tokenSource: source }, source === "JOBS_BOT_TOKEN" ? "Jobs bot token: JOBS_BOT_TOKEN" : "Jobs bot token: falling back to TELEGRAM_BOT_TOKEN (set JOBS_BOT_TOKEN)");

  healthServer = startJobsHealthServer();
  if (TELEGRAM_POLLING_ENABLED) await startJobsBot();
  else log.info("Telegram polling disabled (TELEGRAM_POLLING_ENABLED=false); crons still send");
  startJobsScheduler();
  log.info("FounderOS jobs running");
}

async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, "Shutdown signal received");
  healthServer?.close();
  await stopJobsBot();
  await closeDatabaseConnections();
  releaseSingleInstanceLock();
  log.info("FounderOS jobs stopped cleanly");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM").catch(console.error));
process.on("SIGINT", () => shutdown("SIGINT").catch(console.error));
process.on("uncaughtException", (err) => {
  log.fatal({ err: err.message, stack: err.stack }, "Uncaught exception, shutting down");
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  log.fatal({ reason: String(reason) }, "Unhandled rejection, shutting down");
  process.exit(1);
});

main().catch((err) => {
  console.error("Startup failed:", err);
  process.exit(1);
});
