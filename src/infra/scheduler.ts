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
} from "../db/queries.js";
import { providerLinkedInPost } from "./providers/index.js";
import { sendToChat } from "./telegram-send.js";
import { childLogger } from "./logger.js";
import { TENANT, env } from "../core/config.js";
import type { ScheduledPost } from "../db/schema.js";
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
  cron.schedule("* * * * *", () => {
    runScheduledPostSweep().catch((err) =>
      log.error({ err: (err as Error).message }, "Scheduled post sweep cron error"),
    );
  });
  log.info(
    "Scheduler started — stale-approval check (daily 9am), budget alerts (hourly), brain sync (daily 2am), checkpoint sweep (daily 3:30am), scheduled-post sweep (every minute)",
  );
}
