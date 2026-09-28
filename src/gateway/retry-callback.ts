/**
 * FounderOS — tapping 🔁 Retry
 * ============================
 * Re-runs the failed turn's own words, as the same candidate, once.
 *
 * The text comes from the thread's checkpoint (`state.turn`, the LAST turn the
 * kernel ran), never from the button and never from memory:
 * - a card tapped after a deploy restart still resolves (Postgres holds it);
 * - once a newer turn has run, `state.turn` is that turn, the nonce no longer
 *   matches, and the tap is answered as stale instead of re-running old text;
 * - a double tap runs once. grammY's built-in polling handles updates one at a
 *   time (bot.js handleUpdates, "sequentially"), and this handler awaits the
 *   retried turn, so the second tap is only read after the first retry has
 *   written its new turn id. That property lives in the test that pins it.
 *
 * Re-sends: every gated send is content-keyed and time-invariant (idemKey,
 * src/infra/hitl.ts) and send_email also refuses a recent re-send to the same
 * recipient before its approval card, so a retry either stops or asks again —
 * tests/unit/agents/retry-resend-safety.test.ts.
 *
 * Owner-only in groups: telegram.ts treats `retry:` as a decision button, since
 * it re-runs his turn (a failed /task included) under whoever tapped.
 */

import type { Context } from "grammy";
import { getKernel } from "./kernel-boot.js";
import { runKernelText, threadIdFor } from "./kernel-run.js";
import { listProfiles } from "../tools/jobhunt/profile-config.js";
import { RETRY_CALLBACK_PREFIX, parseRetryCallback } from "./retry-button.js";
import { logger } from "../infra/logger.js";

const log = logger.child({ module: "retry-callback" });

export const STALE_RETRY_TEXT = "This retry is for an older message — send it again if you still need it.";
const UNREADABLE_TEXT = "Couldn't load that message — send it again.";

export interface RetryCallbackDeps {
  /** The thread's latest turn from the checkpointer, or null when there is none. */
  loadTurn(chatId: string | number): Promise<{ id: string; raw_input: string } | null>;
  runKernelText(ctx: Context, text: string, profileId?: string): Promise<void>;
  isKnownProfile(profileId: string): boolean;
}

function defaultDeps(): RetryCallbackDeps {
  return {
    loadTurn: async (chatId) => {
      const kernel = await getKernel();
      const snapshot = (await kernel.getState({ configurable: { thread_id: threadIdFor(chatId) } })) as {
        values?: { turn?: { id?: unknown; raw_input?: unknown } };
      };
      const turn = snapshot?.values?.turn;
      return typeof turn?.id === "string" && typeof turn.raw_input === "string"
        ? { id: turn.id, raw_input: turn.raw_input }
        : null;
    },
    runKernelText,
    isKnownProfile: (profileId) => listProfiles().some((p) => p.id === profileId),
  };
}

/** Best-effort: a button that cannot be removed is refused as stale on its next tap anyway. */
async function removeButton(ctx: Context): Promise<void> {
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
  } catch (err) {
    // allow-failopen: the next tap on a button left behind is answered as stale by the nonce check.
    log.warn({ err: String(err) }, "Could not remove the Retry button");
  }
}

/** Returns false for any payload that is not a retry, so telegram.ts falls through to its other handlers. */
export async function handleRetryCallback(ctx: Context, deps: RetryCallbackDeps = defaultDeps()): Promise<boolean> {
  const data = ctx.callbackQuery?.data ?? "";
  if (!data.startsWith(RETRY_CALLBACK_PREFIX)) return false;

  const target = parseRetryCallback(data);
  const chatId = ctx.chat?.id;
  if (!target || chatId === undefined || (target.profileId && !deps.isKnownProfile(target.profileId))) {
    await ctx.answerCallbackQuery({ text: STALE_RETRY_TEXT });
    return true;
  }

  let turn: { id: string; raw_input: string } | null;
  try {
    turn = await deps.loadTurn(chatId);
  } catch (err) {
    log.warn({ err: String(err), chatId }, "Retry tap: checkpoint read failed");
    await ctx.answerCallbackQuery({ text: UNREADABLE_TEXT });
    return true;
  }

  if (!turn || !turn.id.startsWith(target.nonce) || !turn.raw_input.trim()) {
    await ctx.answerCallbackQuery({ text: STALE_RETRY_TEXT });
    await removeButton(ctx);
    return true;
  }

  await ctx.answerCallbackQuery({ text: "🔁 Retrying…" });
  await removeButton(ctx);
  await deps.runKernelText(ctx, turn.raw_input, target.profileId);
  return true;
}
