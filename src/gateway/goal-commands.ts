/**
 * FounderOS — /goal and /goals
 * ============================
 * Goals with a daily standup, run by deterministic code. The commands are owner-only
 * (OWNER_ONLY_COMMANDS in chat-access.ts), so the transport refuses a guest before a handler runs; the
 * buttons check the same thing themselves (goal-buttons.ts). Registered from telegram.ts with ONE call,
 * `registerGoalCommands(bot, access)`, placed before the catch-all callback and message handlers.
 *
 *   /goals   the ordered list, each goal's metric read live and shown against its target: the same
 *            evaluation and renderer as the 09:00 standup, mutating nothing
 *   /goal …  add, report a value, done, drop, block, unblock (goal-actions.ts)
 *
 * No model-callable tool creates or edits a goal: these commands are the only write path.
 */

import type { Bot, Context } from "grammy";
import { evaluateGoals } from "../goals/evaluate.js";
import { localDateKey } from "../goals/local-date.js";
import { renderStandup } from "../goals/render.js";
import type { ChatAccessConfig } from "./chat-access.js";
import { dispatchGoalCommand, errorText, replyHtml, usageText } from "./goal-actions.js";
import { handleGoalCallback } from "./goal-buttons.js";
import { defaultGoalDeps, type GoalCommandDeps } from "./goal-deps.js";

export async function handleGoal(ctx: Context, deps: GoalCommandDeps): Promise<void> {
  const replyTo = ctx.message?.message_id;
  await dispatchGoalCommand(ctx, deps, ctx.match?.toString() ?? "", replyTo !== undefined ? { replyTo } : {});
}

export async function handleGoals(ctx: Context, deps: GoalCommandDeps): Promise<void> {
  try {
    const repo = await deps.repo();
    const open = await repo.listOpenGoals(deps.tenant);
    if (open.length === 0) {
      await replyHtml(ctx, `No goals yet. Add one:\n\n${usageText()}`);
      return;
    }
    const now = deps.now();
    const timeZone = deps.timeZone();
    const today = localDateKey(now, timeZone);
    const numbering = new Map(open.map((g, i) => [g.id, i + 1]));
    const evaluations = await evaluateGoals(open, numbering, await deps.metrics(), { now, timeZone, today });
    for (const message of renderStandup(evaluations, { heading: "Goals", today, timeZone, mode: "list" })) {
      await replyHtml(ctx, message.text, message.keyboard.length > 0 ? { reply_markup: { inline_keyboard: message.keyboard.map((row) => [...row]) } } : {});
    }
  } catch (err) {
    deps.log.error({ component: "goal-commands", command: "goals", error: errorText(err) }, "Goal list failed");
    await replyHtml(ctx, `❌ Could not load your goals: ${errorText(err)}. Check the server log.`);
  }
}

/**
 * Register /goal, /goals and the goal buttons. The callback handler passes anything that is not a goal
 * button on with `next()`, so approve/reject, the repo picker, the menu and retry still reach theirs.
 */
export function registerGoalCommands(bot: Bot, access: ChatAccessConfig, deps: GoalCommandDeps = defaultGoalDeps()): void {
  bot.command("goal", (ctx: Context) => handleGoal(ctx, deps));
  bot.command("goals", (ctx: Context) => handleGoals(ctx, deps));
  bot.on("callback_query:data", async (ctx, next) => {
    if (!(await handleGoalCallback(ctx, access, deps))) await next();
  });
}
