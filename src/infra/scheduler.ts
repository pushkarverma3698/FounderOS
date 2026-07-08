/**
 * FounderOS v3 — maintenance scheduler.
 * ======================================
 * Zero-LLM maintenance crons only. The v2 feature crons (Monday brief,
 * outbound/proof-drop/social nudges, LinkedIn comment sweep, dept-signal
 * consumer) died with the old orchestration layers in the v3 kill order;
 * they return as kernel-planned scheduled missions when re-justified.
 *
 * What remains, and why it stays:
 *  - stale-approval reminder: a pending HITL card must never rot silently
 *  - budget threshold alerts: 80%/100% of the daily cap, deduped per day
 *  - checkpoint TTL sweep: bounds agents.checkpoints growth
 *  - nightly brain:sync: prevents the empty-RAG production outage class
 */

import cron from "node-cron";
import { spawn } from "node:child_process";
import { getPendingInterrupt, getTodayCostUsd } from "../db/queries.js";
import { sendToChat } from "./telegram-send.js";
import { childLogger } from "./logger.js";
import { TENANT, env } from "../core/config.js";
import {
  assessDailyBudget,
  formatBudgetThresholdAlert,
  nextBudgetAlertThreshold,
  getDailyBudgetCapUsd,
} from "./daily-budget.js";
import { getBudgetAlertsState, recordBudgetAlertSent } from "./daily-budget-alerts.js";
import { sweepStaleCheckpoints } from "./checkpointer.js";

const log = childLogger({ module: "scheduler" });

function getCheckpointTtlDays(): number {
  const raw = Number(process.env["CHECKPOINT_TTL_DAYS"] ?? 14);
  return Number.isFinite(raw) && raw > 0 ? raw : 14;
}

/** Daily 9am — remind the founder about an approval card pending > 1 hour. */
export async function sendStaleApprovalReminder(): Promise<void> {
  const threadId = `${TENANT}:${env.TELEGRAM_CHAT_ID}`;
  const pending = await getPendingInterrupt(threadId);
  if (!pending?.created_at) return;
  const ageMs = Date.now() - new Date(pending.created_at).getTime();
  if (ageMs < 60 * 60 * 1000) return;
  const hours = Math.round(ageMs / 3_600_000);
  await sendToChat(
    `⏳ <b>Approval still pending</b> (${hours}h) — scroll up to the card or /reset to discard it.`,
    "HTML",
  );
}

/** Hourly — alert at 80% and 100% daily budget (zero LLM, deduped per day). */
export async function sendDailyBudgetAlertIfNeeded(): Promise<void> {
  const spent = await getTodayCostUsd(TENANT);
  const status = assessDailyBudget(spent, getDailyBudgetCapUsd());
  const alertsState = await getBudgetAlertsState(TENANT);
  const threshold = nextBudgetAlertThreshold(status, alertsState.levels);
  if (!threshold) return;
  await sendToChat(formatBudgetThresholdAlert(status, threshold), "HTML");
  await recordBudgetAlertSent(TENANT, threshold);
  log.info({ spent, threshold }, "Daily budget threshold alert sent");
}

/** Daily — purge checkpoints for threads idle past the TTL window (zero LLM). */
export async function runCheckpointSweep(): Promise<void> {
  const days = getCheckpointTtlDays();
  const { threads, rows } = await sweepStaleCheckpoints(days);
  if (threads > 0) log.info({ threads, rows, days }, "Checkpoint TTL sweep purged stale threads");
}

/** Nightly — pnpm brain:sync so the RAG store can never silently go stale/empty. */
export async function runBrainSync(): Promise<void> {
  await new Promise<void>((resolve) => {
    const child = spawn("pnpm", ["brain:sync"], { stdio: "ignore", detached: false });
    child.on("exit", (code) => {
      if (code === 0) {
        log.info("Auto brain sync completed");
      } else {
        log.error({ code }, "Auto brain sync failed");
        sendToChat(`⚠️ Nightly brain:sync exited with code ${code}`, "HTML").catch((err) =>
          log.warn({ err: (err as Error).message }, "brain sync alert send failed"),
        );
      }
      resolve();
    });
    child.on("error", (err) => {
      log.error({ err: err.message }, "Auto brain sync spawn error");
      resolve();
    });
  });
}

export function startScheduler(): void {
  cron.schedule("0 9 * * *", () => {
    sendStaleApprovalReminder().catch((err) =>
      log.error({ err: (err as Error).message }, "Stale approval check failed"),
    );
  });
  cron.schedule("0 * * * *", () => {
    sendDailyBudgetAlertIfNeeded().catch((err) =>
      log.error({ err: (err as Error).message }, "Daily budget alert check failed"),
    );
  });
  cron.schedule("30 3 * * *", () => {
    runCheckpointSweep().catch((err) =>
      log.error({ err: (err as Error).message }, "Checkpoint TTL sweep cron error"),
    );
  });
  cron.schedule("0 2 * * *", () => {
    runBrainSync().catch((err) => log.error({ err: (err as Error).message }, "Auto brain sync cron error"));
  });
  log.info(
    "Scheduler started — stale-approval check (daily 9am), budget alerts (hourly), brain sync (daily 2am), checkpoint sweep (daily 3:30am)",
  );
}
