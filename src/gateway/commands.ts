/**
 * FounderOS v3 — /command handlers (essential set).
 * ==================================================
 * The v2 command surface (20 commands: outbound, proofdrop, miso, workflows,
 * signals, targets, …) died with the old orchestration layers in the v3 kill
 * order. What remains is the operational minimum; new commands return only
 * when a kernel-backed feature needs them.
 */

import type { Context } from "grammy";
import { logger } from "../infra/logger.js";
import { getSystemStatus, formatStatusMessage } from "./status.js";
import { cancelPendingApprovals, getTodayCostUsd, getCostBreakdown } from "../db/queries.js";
import { clearThreadCheckpoints } from "../infra/checkpointer.js";
import { engageHalt, releaseHalt, readHalt } from "../infra/halt.js";
import { buildWelcomeMessage } from "./capability-message.js";
import { safeHtml } from "./approval-card.js";
import { TENANT, DAILY_BUDGET_USD } from "../core/config.js";
import { assessDailyBudget, formatBudgetDashboard, getRunBudgetCaps } from "../infra/daily-budget.js";

const log = logger.child({ module: "commands" });

function threadIdFor(chatId: number | string): string {
  return `${TENANT}:${chatId}`;
}

export async function handleStart(ctx: Context): Promise<void> {
  await ctx.reply(buildWelcomeMessage(ctx.from?.first_name), { parse_mode: "HTML" });
}

/** /reset — explicit founder-initiated thread reset (the ONLY thread wipe in v3). */
export async function handleReset(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id ?? "unknown";
  const threadId = threadIdFor(chatId);
  try {
    await cancelPendingApprovals(threadId);
    await clearThreadCheckpoints(threadId);
    log.info({ chatId }, "Thread reset by founder");
    await ctx.reply("🧹 Thread reset — mission state and pending approvals cleared. Fresh start.");
  } catch (err) {
    await ctx.reply(`❌ Reset failed: ${safeHtml((err as Error).message)}`, { parse_mode: "HTML" });
  }
}

export async function handleStatus(ctx: Context): Promise<void> {
  try {
    const status = await getSystemStatus();
    await ctx.reply(formatStatusMessage(status), { parse_mode: "HTML" });
  } catch (err) {
    await ctx.reply(`❌ Status failed: ${safeHtml((err as Error).message)}`, { parse_mode: "HTML" });
  }
}

export async function handleBudget(ctx: Context): Promise<void> {
  try {
    const [todayUsd, breakdown] = await Promise.all([
      getTodayCostUsd(TENANT),
      getCostBreakdown(TENANT, 7).catch((err) => {
        log.warn({ err: (err as Error).message }, "/budget: breakdown query failed");
        return [];
      }),
    ]);
    const status = assessDailyBudget(todayUsd, DAILY_BUDGET_USD);
    await ctx.reply(formatBudgetDashboard(status, getRunBudgetCaps(), breakdown), { parse_mode: "HTML" });
  } catch (err) {
    log.error({ err: (err as Error).message }, "/budget failed");
    await ctx.reply(`❌ Could not load budget: ${safeHtml((err as Error).message)}`, { parse_mode: "HTML" });
  }
}

export async function handleHalt(ctx: Context): Promise<void> {
  await engageHalt("founder /halt");
  await ctx.reply("🛑 <b>Halted.</b> All new turns are refused until /resume.", { parse_mode: "HTML" });
}

export async function handleResume(ctx: Context): Promise<void> {
  if (!(await readHalt())) {
    await ctx.reply("Not halted — nothing to resume.");
    return;
  }
  await releaseHalt();
  await ctx.reply("▶️ Resumed — the kernel accepts turns again.");
}

export async function handleCommands(ctx: Context): Promise<void> {
  await ctx.reply(
    [
      "<b>Commands</b>",
      "/status — system health + pending approvals",
      "/budget — today's spend vs the daily cap",
      "/reset — clear this thread's mission state",
      "/halt · /resume — emergency stop / restart",
      "",
      "Everything else is natural language — the planner routes it.",
    ].join("\n"),
    { parse_mode: "HTML" },
  );
}
