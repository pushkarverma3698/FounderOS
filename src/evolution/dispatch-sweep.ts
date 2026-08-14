/**
 * Evolution Engine — the acting loop's scheduler entry point.
 * ============================================================
 * Mirrors `audit-sweep.ts` exactly, including the property that file exists to
 * hold: IT ALWAYS SENDS. A crashed dispatch says so. Silence used to be the
 * outcome of every failure in the audit path, and silence is indistinguishable
 * from "nothing to report" — which is how a self-improvement loop can be dead
 * for weeks while looking healthy.
 *
 * Runs at 09:00 every third day, an hour after `runSelfAuditSweep`. The order is
 * deliberate: the founder reads the full audit first and can kill a finding
 * before the loop turns it into unattended work.
 */

import { sendToChat } from "../infra/telegram-send.js";
import { logger } from "../infra/logger.js";
import { runSelfImprovementDispatch } from "./dispatch-findings.js";
import type { DispatchOutcome } from "./dispatch-findings.js";
import { renderDispatchMessage } from "./dispatch-message.js";

const log = logger.child({ module: "dispatch-sweep" });

export async function runSelfImprovementSweep(): Promise<void> {
  let outcome: DispatchOutcome;

  try {
    outcome = await runSelfImprovementDispatch();
    log.info({ state: outcome.state }, "Self-improvement dispatch completed");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.error({ err: reason }, "Self-improvement dispatch failed — reporting the failure to the founder");
    outcome = { state: "failed", reason };
  }

  try {
    await sendToChat(renderDispatchMessage(outcome), "HTML");
  } catch (err) {
    // allow-failopen: the dispatch already ran and any issue it filed already
    // exists. A Telegram outage must not throw into the scheduler's cron
    // callback. Logged loudly because this is the one failure the founder
    // cannot observe from the chat itself.
    log.error({ err: (err as Error).message }, "Self-improvement report could not be delivered to Telegram");
  }
}
