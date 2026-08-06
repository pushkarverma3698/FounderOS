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

// 01:30 UTC = 07:00 IST, every THIRD day (founder decision, 2026-08-02). The
// feed bills per job RETURNED, so cadence changes only how often we re-buy the
// same posting: the 2026-08-02 sweep was billed for 32 of which ZERO were new,
// and daily bought that inventory three times over ($14.05/mo against $4.68).
export const JOB_SWEEP_CRON = "30 1 */3 * *";

/**
 * Every third day — sweep every source pool, screen everything, send a BRIEF.
 *
 * Zero-LLM: the fetch is HTTP, every gate is pure code, and ranking is a set
 * intersection, so this runs unattended without touching the model budget.
 *
 * What the founder receives is a ranked shortlist with one command per row, not
 * a log of verdicts. The previous version screened flawlessly and produced zero
 * applications for weeks: screening was never the binding constraint, and a
 * report that costs nothing to ignore will be ignored.
 *
 * A total failure still sends. A sweep that goes quiet is indistinguishable from
 * a market with no jobs in it, and that ambiguity is exactly why the founder
 * would stop trusting the number.
 */
export async function runJobIngestSweep(): Promise<void> {
  const { runPooledIngest } = await import("../tools/jobhunt/ingest.js");
  const { buildDailyBrief } = await import("../tools/jobhunt/daily-brief.js");
  const { toTelegramSafe, splitForTelegram } = await import("../tools/jobhunt/brief.js");

  const result = await runPooledIngest({
    limit: JOB_INGEST_DAILY_LIMIT,
    includeIndeed: true,
  });

  if (result.fetched === 0 && result.failures.length > 0) {
    log.warn({ failures: result.failures }, "Daily job ingest failed on every source");
    // Escaped, not raw: sendToChat defaults to parse_mode "HTML", and real job
    // titles carry "&" and "<" ("Bloom & Wild Group", prod 2026-07-31). Telegram
    // rejects the WHOLE message on an unparseable entity — the alert must not
    // fail on the alert's own content.
    await sendToChat(
      toTelegramSafe(`⚠ Job sweep failed — nothing was screened today.\n${result.failures.join("\n")}`),
    );
    return;
  }

  log.info(
    { fetched: result.fetched, failures: result.failures.length },
    "Daily job ingest complete",
  );

  try {
    // NOT escaped here. The brief renders its own Telegram HTML and escapes every
    // value at the point it is interpolated (see telegram-format.ts) — running a
    // whole-message escape over it would print "&lt;b&gt;" at the founder rather
    // than bolding anything, which is the exact "message is not formatted"
    // complaint that started this.
    //
    // Chunked because Telegram rejects a body over 4,096 characters outright, and
    // nothing in the send path splits. Before this, a brief that finally had
    // enough supply to be worth reading would have been dropped whole — and the
    // failure would have looked like a sweep that found nothing.
    const brief = await buildDailyBrief({
      screened: result.fetched,
      failures: result.failures,
      // Kept apart from `failures` all the way through. A day that correctly
      // skipped eight expired listings is a working day, and printing that under
      // "incomplete run" would teach the founder to distrust a healthy sweep.
      notes: result.notes,
    });
    for (const part of splitForTelegram(brief)) {
      await sendToChat(part);
    }
  } catch (err) {
    // The postings ARE screened and recorded by this point. Losing the brief must
    // not read as losing the sweep, so say which one actually failed.
    log.error({ err: (err as Error).message }, "Daily brief render failed");
    // Escaped too: this is the path that runs BECAUSE the brief failed, so an
    // unescaped error message here would lose the founder the fallback as well.
    await sendToChat(
      toTelegramSafe(
        `⚠ Screened ${result.fetched} posting(s), but the brief could not be built: ` +
          `${(err as Error).message}\nThe screening results are recorded — run /jobs to read them.`,
      ),
    );
  }
}

/**
 * Daily ATS volume, as a TOTAL split evenly across the sweep's ATS queries.
 *
 * The number was 30 and it capped nothing. The sweep runs one query per
 * (pool × track) and the actor rejects any limit below 10, so the real budget is
 * `max(10, floor(total / queries))` per query — and at 30 across 8 queries that
 * floor won every time. The sweep was quietly free to fetch 100 postings while
 * a constant named DAILY_LIMIT said 30. A budget that does not bind is worse
 * than no budget: it is a number the founder would reason about that has no
 * relationship to what is spent.
 *
 * IT BECAME FICTION ANYWAY: the India pool took the sweep from 8 ATS queries to
 * 12 without touching this, so the ceiling silently became 120 + 20 Indeed, and
 * on 2026-08-06 it bought 92 postings for $0.997 while this said 80. A
 * per-posting count cannot bind a per-query floor. THE CAP THAT BINDS IS IN
 * DOLLARS — `spend-gate.ts`, before the first actor call of every sweep.
 */
const JOB_INGEST_DAILY_LIMIT = 80;

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
  cron.schedule(JOB_SWEEP_CRON, () => {
    runJobIngestSweep().catch((err) =>
      log.error({ err: (err as Error).message }, "Job ingest sweep cron error"),
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
    "Scheduler started — stale-approval check (daily 9am), budget alerts (hourly), brain sync (daily 2am), job ingest (daily 1:30am UTC), checkpoint sweep (daily 3:30am), scheduled-post + reminder sweeps (every minute)" +
      (taskExecutor ? ", scheduled-task sweep (every minute)" : ""),
  );
}
