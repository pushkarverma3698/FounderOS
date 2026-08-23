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
 *
 * DISABLED 2026-08-21 (founder directive — paid crons producing no acted-on
 * output): the metered job-ingest sweep (JOB_SWEEP_CRON, $0.46/run — the free
 * board sweep above already covers discovery), the self-audit sweep
 * (audit-sweep.ts — findings were never persisted, `writeTaskOutcome` had zero
 * callers), the self-improvement dispatch (dispatch-sweep.ts — blocked on
 * `resolveExecutorCwd` refusing both hosts, entirely inert), and the weekly RAG
 * optimization sweep (rag-optimization-sweep.ts). The functions and their unit
 * tests are untouched — only the `cron.schedule()` registration was removed —
 * so re-enabling any one of them is a one-line change in `startScheduler`.
 */

import cron from "node-cron";
import { spawn } from "node:child_process";
import {
  getPendingInterrupt,
  getTodayCostUsd,
  claimDueScheduledPosts,
  markScheduledPostPosted,
  markScheduledPostFailed,
  hasBeenAudited,
  writeAuditEntry,
  claimDueScheduledTasks,
  markScheduledTaskFailed,
  claimDueReminders,
  markReminderFired,
  advanceReminder,
  reclaimStrandedReminders,
} from "../db/queries.js";
import { nextRecurrence } from "../core/time.js";
import { providerLinkedInPost } from "./providers/index.js";
import { sendToChat } from "./telegram-send.js";
import { childLogger } from "./logger.js";
import { TENANT, env } from "../core/config.js";
import type { ScheduledPost, ScheduledTask } from "../db/schema.js";
import {
  assessDailyBudget,
  formatBudgetThresholdAlert,
  nextBudgetAlertThreshold,
  getDailyBudgetCapUsd,
} from "./daily-budget.js";
import { getBudgetAlertsState, recordBudgetAlertSent } from "./daily-budget-alerts.js";
import { sweepStaleCheckpoints } from "./checkpointer.js";
import {
  JOB_SWEEP_CRON,
  runJobIngestSweep,
  FREE_SWEEP_CRON,
  runFreeSweep,
} from "../tools/jobhunt/sweep-runner.js";

// Re-exported so existing import sites (and tests) that read these off
// scheduler.ts keep resolving after the move to sweep-runner.ts (2026-08-06).
export { JOB_SWEEP_CRON, runJobIngestSweep };

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

/**
 * Publish one due scheduled post via the provider, then audit + mark it.
 * Zero-LLM: the content was approved by the founder at schedule time. Idempotent
 * — a prior audit of the same key (crash between post and mark) short-circuits.
 */
async function publishScheduledPost(post: ScheduledPost): Promise<void> {
  if (await hasBeenAudited(post.idempotency_key)) {
    await markScheduledPostPosted(post.id, post.post_id ?? "already-posted");
    return;
  }
  if (post.platform !== "linkedin") {
    await markScheduledPostFailed(post.id, `Unsupported platform '${post.platform}' — only linkedin is wired.`);
    return;
  }

  const mention =
    post.mention_urn && post.mention_name
      ? { urn: post.mention_urn, name: post.mention_name }
      : undefined;

  const result = await providerLinkedInPost({
    text: post.text,
    author_urn: "", // provider resolves from the account registry
    visibility: post.visibility === "CONNECTIONS" ? "CONNECTIONS" : "PUBLIC",
    mention,
    account_key: post.account_key,
    department: "marketing",
  });

  if (!result.success) {
    await markScheduledPostFailed(post.id, result.error ?? "unknown provider error");
    await sendToChat(
      `⚠️ <b>Scheduled LinkedIn post failed</b>\n${result.error ?? "unknown error"}\n\n"${post.text.slice(0, 120)}…"`,
      "HTML",
    );
    return;
  }

  const data = result.data as Record<string, unknown> | undefined;
  const postId = (data?.["post_id"] as string | undefined) ?? "";
  const postUrl = data?.["post_url"] as string | undefined;

  // Audit row keyed on the SAME idempotency_key so a retried sweep can't double-post.
  await writeAuditEntry({
    tenant_id: post.tenant_id,
    action: "linkedin_post",
    idempotency_key: post.idempotency_key,
    payload: { post_id: postId, scheduled: true, tagged: !!mention, text: post.text.slice(0, 100) },
  });
  await markScheduledPostPosted(post.id, postId, postUrl);
  await sendToChat(
    `✅ <b>Scheduled LinkedIn post published</b>${mention ? ` (tagged @${mention.name})` : ""}\n${postUrl ?? ""}`,
    "HTML",
  );
  log.info({ id: post.id, post_id: postId }, "Scheduled post published");
}

/** Every minute — publish any scheduled posts whose time has arrived (zero-LLM). */
export async function runScheduledPostSweep(): Promise<void> {
  // Atomically claim due rows ('scheduled' → 'posting') so an overlapping tick
  // (this cron fires every minute and does not await the prior run) can never
  // re-select and republish the same post. See claimDueScheduledPosts.
  const due = await claimDueScheduledPosts(TENANT, new Date());
  for (const post of due) {
    try {
      await publishScheduledPost(post);
    } catch (err) {
      const message = (err as Error).message;
      log.error({ id: post.id, err: message }, "Scheduled post sweep error");
      // allow-failopen: already logged above; a failed mark-failed must not abort the sweep for the remaining due posts.
      await markScheduledPostFailed(post.id, message).catch(() => undefined);
    }
  }
}

/**
 * Fires one claimed scheduled task. Injected from src/index.ts (the runner
 * needs the kernel + bot API, which live in gateway — infra must not import
 * gateway, so the dependency arrives inverted).
 */
export type ScheduledTaskExecutor = (task: ScheduledTask) => Promise<void>;

/** Every minute — fire any scheduled agent tasks whose time has arrived. */
export async function runScheduledTaskSweep(executor: ScheduledTaskExecutor): Promise<void> {
  // Atomic claim ('scheduled' → 'running') — overlap-safe, same as the post sweep.
  const due = await claimDueScheduledTasks(TENANT, new Date());
  for (const task of due) {
    try {
      await executor(task);
    } catch (err) {
      const message = (err as Error).message;
      log.error({ id: task.id, err: message }, "Scheduled task sweep error");
      // allow-failopen: already logged above; a failed mark-failed must not abort the sweep for the remaining due tasks.
      await markScheduledTaskFailed(task.id, message).catch(() => undefined);
    }
  }
}

/** Minimal HTML escape for founder-supplied reminder text sent with parse_mode HTML. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Every minute — ping any reminders whose time has arrived (ZERO-LLM). A
 * reminder never executes anything: it sends its text straight to chat. One-shot
 * rows are marked 'fired'; recurring rows re-arm to their next occurrence. The
 * send failing for one row must not abort the sweep for the rest.
 */
export async function runReminderSweep(now: Date = new Date()): Promise<void> {
  const due = await claimDueReminders(TENANT, now);
  for (const rem of due) {
    try {
      await sendToChat(`⏰ <b>Reminder</b>\n${escapeHtml(rem.text)}`, "HTML");
      if (rem.recurrence) {
        await advanceReminder(rem.id, nextRecurrence(rem.recurrence, now, rem.timezone), now);
      } else {
        await markReminderFired(rem.id, now);
      }
    } catch (err) {
      // allow-failopen: one reminder's send/mark blip must not stop the others; the row stays 'firing' and boot recovery re-pings it.
      log.error({ id: rem.id, err: (err as Error).message }, "Reminder sweep error");
    }
  }
}

/**
 * Boot-time recovery: requeue reminders left in 'firing' by a crash (the
 * single-instance lock means any 'firing' row at boot is stranded). Called once
 * from src/index.ts before the sweep starts. At-least-once: a duplicate ping
 * beats a dropped reminder.
 */
export async function recoverStrandedReminders(): Promise<void> {
  const requeued = await reclaimStrandedReminders(TENANT);
  if (requeued.length > 0) {
    log.warn({ ids: requeued.map((r) => r.id) }, "Reclaimed reminders stranded in 'firing' by a crash/restart");
  }
}

/** Daily 2am — Sweep funding news and grow the free-lane board registry (zero-LLM). */
export async function runFundingGrowerSweep(): Promise<void> {
  await new Promise<void>((resolve) => {
    log.info("Starting funding registry grower sweep");
    const child = spawn("node", ["--import", "tsx/esm", "scripts/jobhunt-funding-grow.ts"], { stdio: "ignore", detached: false });
    child.on("exit", (code) => {
      if (code === 0) {
        log.info("Funding registry grower sweep completed");
      } else {
        log.error({ code }, "Funding registry grower sweep failed");
      }
      resolve();
    });
    child.on("error", (err) => {
      log.error({ err: err.message }, "Funding registry grower spawn error");
      resolve();
    });
  });
}



export function startScheduler(opts?: { taskExecutor?: ScheduledTaskExecutor }): void {
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
  cron.schedule("0 2 * * *", () => {
    runFundingGrowerSweep().catch((err) => log.error({ err: (err as Error).message }, "Funding registry grower cron error"));
  });
  cron.schedule(FREE_SWEEP_CRON, () => {
    runFreeSweep().catch((err) =>
      log.error({ err: (err as Error).message }, "Free board sweep cron error"),
    );
  });
  cron.schedule("* * * * *", () => {
    runScheduledPostSweep().catch((err) =>
      log.error({ err: (err as Error).message }, "Scheduled post sweep cron error"),
    );
  });
  cron.schedule("* * * * *", () => {
    runReminderSweep().catch((err) =>
      log.error({ err: (err as Error).message }, "Reminder sweep cron error"),
    );
  });
  const taskExecutor = opts?.taskExecutor;
  if (taskExecutor) {
    cron.schedule("* * * * *", () => {
      runScheduledTaskSweep(taskExecutor).catch((err) =>
        log.error({ err: (err as Error).message }, "Scheduled task sweep cron error"),
      );
    });
  }
  log.info(
    "Scheduler started — stale-approval check (daily 9am), budget alerts (hourly), brain sync (daily 2am), free board sweep (every 30 minutes), checkpoint sweep (daily 3:30am), scheduled-post + reminder sweeps (every minute)" +
      (taskExecutor ? ", scheduled-task sweep (every minute)" : ""),
  );
}
