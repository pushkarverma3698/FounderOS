/**
 * FounderOS v3 — provider-exhaustion auto-retry (2026-07-13 prod audit).
 * ======================================================================
 * When the whole model fallback chain is exhausted (a transient provider
 * rate-limit/outage), making the founder manually type "try again" is bad UX
 * and often forgotten. Instead we queue ONE retry of the SAME turn a few
 * minutes out through the existing scheduled_tasks sweep — the retry fires as
 * a normal kernel turn on the founder's own thread.
 *
 * Loop safety by construction: the retry runs via runDueScheduledTask, whose
 * own error path does NOT re-enqueue, so a single live turn yields at most one
 * auto-retry. Idempotency is per-turn (key = turnId) so a double-report of the
 * same exhaustion cannot double-queue.
 */

import { TENANT } from "../core/config.js";
import { insertScheduledTask } from "../db/queries.js";
import { logger } from "../infra/logger.js";

const log = logger.child({ module: "auto-retry" });

/** Delay before the one-shot retry fires — long enough for a transient throttle to clear. */
export const AUTO_RETRY_DELAY_MS = 3 * 60 * 1000;

/**
 * Queue a one-shot retry of `text` on `chatId` ~3 minutes out. Returns false
 * when the queue write fails so the caller can fall back to the manual
 * "send try again" path — a DB blip must never swallow the founder's request.
 */
export async function enqueueTurnAutoRetry(chatId: string, text: string, turnId: string): Promise<boolean> {
  try {
    await insertScheduledTask({
      tenant_id: TENANT,
      prompt: text,
      chat_id: chatId,
      scheduled_at: new Date(Date.now() + AUTO_RETRY_DELAY_MS),
      idempotency_key: `auto-retry:${turnId}`,
    });
    return true;
  } catch (err) {
    // allow-failopen: a queue-write blip degrades to the manual retry reply, never crashes the error path
    log.warn({ err: String(err), turnId }, "Auto-retry enqueue failed — falling back to manual retry");
    return false;
  }
}
