/**
 * The checks a text turn must pass before the kernel runs: halt, a waiting approval, the daily budget.
 *
 * Split out of kernel-run.ts (400-line budget) when the "Working on it" ack moved in front of them: the
 * ack is already on screen while these run, so a gate that refuses must take it away BEFORE it says why,
 * or the founder sees a stuck "Working on it" next to the refusal.
 */
import { type Context } from "grammy";
import { TENANT, DAILY_BUDGET_USD } from "../core/config.js";
import type { ApprovalRequest } from "../infra/hitl.js";
import { formatApprovalCard } from "./approval-card.js";
import { getPendingInterrupt, resolveInterrupt, getTodayCostUsd } from "../db/queries.js";
import { assertDailyBudgetAllowsRun } from "../infra/daily-budget.js";
import { readHalt, formatHaltNotice } from "../infra/halt.js";
import { logger } from "../infra/logger.js";
import type { TurnAck } from "./kernel-progress.js";

const log = logger.child({ module: "turn-gates" });

/** Only re-post HITL cards paused within this window (crash recovery). */
export const HITL_RESTORE_MAX_AGE_MS = 2 * 60 * 60 * 1000;

export async function sendApprovalCard(ctx: Context, approval: ApprovalRequest, nonce?: string): Promise<void> {
  const card = formatApprovalCard(approval, { nonce });
  await ctx.reply(card.html, { parse_mode: "HTML", reply_markup: card.keyboard });
}

/**
 * A text turn must not start while an approval card is waiting on the same thread:
 * the new run would share the old checkpoint and pending row, so one tap would
 * resume (or silently drop) the wrong request. Re-send the card and say so. A card
 * older than the restore window is abandoned, so expire it instead of blocking forever.
 * Returns true when the turn was held.
 */
async function holdForPendingApproval(ctx: Context, threadId: string, ack: TurnAck): Promise<boolean> {
  const pending = await getPendingInterrupt(threadId);
  if (!pending) return false;
  const age = Date.now() - new Date(pending.created_at ?? 0).getTime();
  if (age > HITL_RESTORE_MAX_AGE_MS) {
    await resolveInterrupt(pending.interrupt_id, "expired");
    return false;
  }
  const payload = JSON.parse(pending.callback_data ?? "{}") as Omit<ApprovalRequest, "kind">;
  await ack.remove();
  await ctx.reply(
    "⏸ Not started: an approval is still waiting. Approve or reject the card below, then send your message again.",
  );
  await sendApprovalCard(ctx, { kind: "approval", ...payload }, pending.interrupt_id.substring(0, 8));
  return true;
}

/**
 * Returns true when the turn may run. A halted state or a waiting approval answers the founder itself and
 * returns false, with the ack already removed. An exhausted daily budget THROWS (DailyBudgetExceededError)
 * and the caller's error path removes the ack and replies; the kernel has not been touched in any of the three.
 */
export async function passTurnGates(ctx: Context, chatId: string | number, threadId: string, ack: TurnAck): Promise<boolean> {
  const halt = await readHalt();
  if (halt) {
    await ack.remove();
    await ctx.reply(formatHaltNotice(halt), { parse_mode: "HTML" });
    return false;
  }
  if (await holdForPendingApproval(ctx, threadId, ack)) return false;
  await assertDailyBudgetAllowsRun(
    () => getTodayCostUsd(TENANT),
    DAILY_BUDGET_USD,
    (msg) => log.warn({ chatId, err: msg }, "Daily budget check skipped — fail-open"),
  );
  return true;
}
