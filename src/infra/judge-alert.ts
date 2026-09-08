/**
 * FounderOS — tell the founder his outbound quality gate stopped running
 * ======================================================================
 * The announcement half of judge-health.ts, split into its own file because
 * scheduler.ts is at its 400-line fitness budget and because this is a
 * different concern: judge-health RECORDS, this one SPEAKS.
 *
 * Wired to the hourly cron in scheduler.ts — that registration, not this
 * comment, is what makes a judge outage visible (rule #27).
 */

import { judgeHealth, markJudgeOutageAlerted } from "./judge-health.js";
import { judgeModelLabel } from "./judge.js";
import { sendToChat } from "./telegram-send.js";
import { childLogger } from "./logger.js";

const log = childLogger({ module: "judge-alert" });

/** Telegram HTML-safe. Local rather than imported: infra must not depend on gateway. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Hourly — one message per outage episode, or nothing.
 *
 * `judgeOutbound` fails open by design, so a dead judge model and a clean pass
 * are indistinguishable from outside. Three withdrawn free OpenRouter slugs in
 * three weeks each turned gate 2 into a silent no-op that only a raw log grep
 * revealed — the last one within hours of being "fixed" (2026-09-07: replaced,
 * deployed, and 404ing on every outbound reply the same evening).
 *
 * The message says plainly that drafts went to approval UNREVIEWED, and equally
 * plainly that nothing sent on its own — an alert that reads as "something was
 * sent unchecked" would be a worse lie than the silence it replaces.
 */
export async function sendJudgeOutageAlertIfNeeded(): Promise<void> {
  const health = judgeHealth();
  if (!health.shouldAlert) return;
  await sendToChat(
    `⚠️ <b>Outbound quality gate is not running</b>\n` +
      `The independent judge has failed ${health.consecutiveFailures} calls in a row, so drafts have been ` +
      `reaching your approval card <b>unreviewed</b>. Nothing sent on its own — your approval still gates every send.\n` +
      `Model: <code>${escapeHtml(judgeModelLabel())}</code>\n` +
      `Last error: <code>${escapeHtml(health.lastError.slice(0, 300))}</code>\n` +
      `Fix: set <code>JUDGE_MODEL</code> to a live slug (free OpenRouter models are withdrawn without notice).`,
    "HTML",
  );
  markJudgeOutageAlerted();
  log.error(
    { consecutiveFailures: health.consecutiveFailures, lastError: health.lastError },
    "Judge outage alert sent — gate 2 is failing open",
  );
}
