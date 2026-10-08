/**
 * A message sent while an approval card waits (AG-047).
 *
 * It used to be refused ("send your message again") and dropped. Now it is kept on the pending card's row
 * (hitl_approvals.held_text, one per card, the newest wins), so a deploy restart between hold and tap loses nothing.
 * When the founder answers the card and the resume turn has replied, the text runs as an ordinary turn, taking the
 * chat lock after the resume turn. It is never read as an answer to the card.
 *
 * Out of turn-gates.ts and kernel-run.ts (400-line budget). `run` is passed in rather than imported so this module
 * does not depend on kernel-run.
 */
import { type Context } from "grammy";
import { claimHeldMessage, getPendingInterrupt, holdMessageOnInterrupt } from "../db/queries.js";
import { logger } from "../infra/logger.js";

const log = logger.child({ module: "held-message" });

/** Same window as the card restore: a message older than this is not run behind a tap that came much later. */
const HELD_MAX_AGE_MS = 2 * 60 * 60 * 1000;

export const HOLD_REPLY = "⏸ Holding this until you answer the card above.";
const HOLD_REPLACED_NOTE = "It replaces the message I was holding before.";

function preview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat;
}

/**
 * Keep `text` behind the pending card. Returns false when the card was resolved before the write landed, so the
 * caller does not claim a hold that did not happen.
 */
export async function holdMessage(ctx: Context, pending: { interrupt_id: string; held_text?: string | null }, text: string): Promise<boolean> {
  if (!(await holdMessageOnInterrupt(pending.interrupt_id, text))) return false;
  await ctx.reply(pending.held_text ? `${HOLD_REPLY} ${HOLD_REPLACED_NOTE}` : HOLD_REPLY);
  return true;
}

/** The card expired unanswered: what was held behind it is dropped, and the founder is told which message. */
export async function dropHeldMessage(ctx: Context, interruptId: string, why: string): Promise<void> {
  const held = await claimHeldMessage(interruptId);
  if (!held) return;
  await ctx.reply(`⏸ Dropped the message I was holding ("${preview(held.text)}"): ${why}. Send it again if you still want it.`);
}

/**
 * After a resume turn has replied (the caller has released the chat lock): run what was held behind the card
 * `interruptId`. If the resume paused again on a new card, the text moves behind that one. Never throws: a failure
 * here is told to the founder, who still has the text in the chat above.
 */
export async function runHeldMessageAfterResume(
  ctx: Context,
  opts: { interruptId: string; threadId: string; run: (ctx: Context, text: string) => Promise<void> },
): Promise<void> {
  try {
    const held = await claimHeldMessage(opts.interruptId);
    if (!held) return;
    if (Date.now() - held.heldAt.getTime() > HELD_MAX_AGE_MS) {
      await ctx.reply(`⏸ Dropped the message I was holding ("${preview(held.text)}"): it was sent over 2 hours ago. Send it again if you still want it.`);
      return;
    }
    const next = await getPendingInterrupt(opts.threadId);
    if (next && (await holdMessageOnInterrupt(next.interrupt_id, held.text, held.heldAt))) return; // the resume raised the next card: keep waiting
    await opts.run(ctx, held.text);
  } catch (err) {
    log.error({ err: String(err), interruptId: opts.interruptId }, "Running the held message failed");
    await ctx.reply("⚠️ I could not run the message I was holding. Please send it again.").catch(() => undefined); // allow-failopen: the failure is logged above; this reply is courtesy
  }
}
