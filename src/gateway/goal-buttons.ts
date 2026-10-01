/**
 * FounderOS — goals: the inline buttons
 * =====================================
 *   goal:p:<id>       Plan next step: one kernel turn on a code-built prompt
 *   goal:m:<i>        a metric family chosen while adding a goal
 *   goal:a:<i>:<arg>  that family's argument (a profile or a repo)
 *
 * EVERY tap is checked with mayActAsOwner BEFORE anything else, the same test the HITL approval
 * callbacks get in telegram.ts. A guest in an allow-listed group can tap a button someone forwarded
 * or that stayed on screen; he gets a refusal, and no kernel turn starts, no storage is read and no goal
 * is created. The check lives here, in the handler, rather than only in a list of prefixes elsewhere: a
 * list is what someone forgets to extend, and a handler cannot be routed around.
 *
 * "Plan next step" detaches the kernel run from the handler. grammY handles updates strictly one at a
 * time, so awaiting a run that can take minutes would hold every other tap and message behind it, and
 * would make a second tap wait and then run again. The per-goal PlanGuard (goal-deps.ts) is what refuses
 * the second tap; the kernel's own per-chat lock still serialises turns for different goals.
 */

import type { Context } from "grammy";
import { GOAL_CALLBACK_PREFIX, decodeGoalCallback } from "../goals/callbacks.js";
import { localDateKey } from "../goals/local-date.js";
import { goalArgsOf } from "../goals/parse.js";
import { PLAN_REVIEW_LIMIT, buildPlanPrompt } from "../goals/plan-prompt.js";
import { esc } from "../tools/jobhunt/telegram-format.js";
import { classifyChatAccess, mayActAsOwner, type ChatAccessConfig } from "./chat-access.js";
import { dispatchGoalCommand, errorText, replyHtml } from "./goal-actions.js";
import type { GoalCommandDeps } from "./goal-deps.js";

/** The slice of a button's message the pickers read: the founder's own message it replies to. */
interface PickerMessage {
  readonly message_id?: number;
  readonly reply_to_message?: { readonly message_id: number; readonly text?: string };
}

async function planNextStep(ctx: Context, deps: GoalCommandDeps, goalId: string): Promise<void> {
  if (!deps.planGuard.tryStart(goalId)) {
    await ctx.answerCallbackQuery({ text: "Already planning this goal: the reply is on its way." });
    return;
  }
  let detached = false;
  try {
    const repo = await deps.repo();
    const goal = await repo.getGoal(deps.tenant, goalId);
    if (goal === null || (goal.status !== "active" && goal.status !== "blocked")) {
      await ctx.answerCallbackQuery({ text: "That goal is no longer open. Send /goals for the current list.", show_alert: true });
      return;
    }
    const open = await repo.listOpenGoals(deps.tenant);
    const prompt = buildPlanPrompt({
      goal,
      number: open.findIndex((g) => g.id === goalId) + 1,
      reviews: await repo.recentReviews(goalId, PLAN_REVIEW_LIMIT),
      today: localDateKey(deps.now(), deps.timeZone()),
    });
    await ctx.answerCallbackQuery({ text: "Planning the next step…" });
    // Detached on purpose: see the header. runKernelText owns its own errors; this catch is for the ones it does not.
    void deps
      .runKernelText(ctx, prompt)
      .catch(async (err: unknown) => {
        deps.log.error({ component: "goal-buttons", goalId, error: errorText(err) }, "Plan next step: the kernel run failed");
        await replyHtml(ctx, `❌ Could not plan that step: ${esc(errorText(err))}. Tap the button again to retry.`).catch((sendErr: unknown) =>
          deps.log.error({ component: "goal-buttons", error: errorText(sendErr) }, "Plan next step: could not tell the founder the run failed"),
        );
      })
      .finally(() => deps.planGuard.finish(goalId));
    detached = true;
  } catch (err) {
    deps.log.error({ component: "goal-buttons", goalId, error: errorText(err) }, "Plan next step: could not start");
    await ctx.answerCallbackQuery({ text: `Could not start: ${errorText(err)}`.slice(0, 190), show_alert: true });
  } finally {
    if (!detached) deps.planGuard.finish(goalId);
  }
}

/** A metric family or argument was tapped: re-read the founder's original /goal add and finish (or continue) it. */
async function continueAdd(ctx: Context, deps: GoalCommandDeps, metricOverride: string): Promise<void> {
  const message = ctx.callbackQuery?.message as unknown as PickerMessage | undefined;
  const original = message?.reply_to_message;
  const args = original?.text === undefined ? null : goalArgsOf(original.text);
  if (original === undefined || args === null) {
    await ctx.answerCallbackQuery({ text: "I can no longer read your original /goal message. Send the command again.", show_alert: true });
    return;
  }
  if (message?.message_id !== undefined && !deps.pickerGuard.claim(message.message_id)) {
    await ctx.answerCallbackQuery({ text: "Already handled." });
    return;
  }
  await ctx.answerCallbackQuery({ text: `→ ${metricOverride}`.slice(0, 190) });
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
  } catch {
    // allow-failopen: clearing a spent keyboard is cosmetic (the message may be too old to edit); the goal step below is the actual work.
  }
  await dispatchGoalCommand(ctx, deps, args, { replyTo: original.message_id, metricOverride });
}

/** Handle a goal button. Returns false for a payload that is not a goal button, so the other handlers still see it. */
export async function handleGoalCallback(ctx: Context, access: ChatAccessConfig, deps: GoalCommandDeps): Promise<boolean> {
  const data = ctx.callbackQuery?.data ?? "";
  if (!data.startsWith(GOAL_CALLBACK_PREFIX)) return false;

  // First, before decoding or reading anything: who tapped. The same test the HITL approve/reject buttons get.
  const who = classifyChatAccess({ chatId: ctx.chat?.id, chatType: ctx.chat?.type, fromId: ctx.from?.id }, access);
  if (!mayActAsOwner(who, ctx.from?.id, access)) {
    await ctx.answerCallbackQuery({ text: "Only the owner can use the goal buttons.", show_alert: true });
    return true;
  }

  const cb = decodeGoalCallback(data);
  if (cb === null) {
    await ctx.answerCallbackQuery({ text: "That button is not valid any more. Send /goals for fresh ones.", show_alert: true });
    return true;
  }
  if (cb.kind === "plan") await planNextStep(ctx, deps, cb.goalId);
  else await continueAdd(ctx, deps, cb.kind === "metric" ? cb.family : `${cb.family}:${cb.arg}`);
  return true;
}
