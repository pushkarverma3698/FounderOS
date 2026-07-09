/**
 * FounderOS v3 — Telegram gateway (transport only).
 * ==================================================
 * Bot lifecycle + event wiring. All orchestration lives in the kernel
 * (src/kernel/) behind ./kernel-run.ts. This file must stay dumb:
 *   /command      → handlers in ./commands.js
 *   message:text  → runKernelText
 *   media         → media handlers → runKernelText
 *   callback      → resumeKernel
 * Thread id = `turicks:{chatId}` — stable per chat so approvals resume
 * the exact paused mission.
 */

import { Bot, type Context } from "grammy";
import { env } from "../core/config.js";
import { logger } from "../infra/logger.js";
import {
  handleStart,
  handleReset,
  handleStatus,
  handleBudget,
  handleHalt,
  handleResume,
  handleCommands,
} from "./commands.js";
import { registerMediaHandlers } from "./media.js";
import { runKernelText, resumeKernel } from "./kernel-run.js";

// media.ts and tests import safeHtml from here — keep the path stable.
export { safeHtml } from "./approval-card.js";
export { runKernelText, resumeKernel, withChatTurnLock, restorePendingApproval } from "./kernel-run.js";

const log = logger.child({ module: "telegram" });

let _bot: Bot | undefined;

export function getBot(): Bot {
  if (!_bot) _bot = new Bot(env.TELEGRAM_BOT_TOKEN);
  return _bot;
}

export function registerHandlers(bot: Bot): void {
  bot.command("start", (ctx: Context) => handleStart(ctx));
  bot.command("reset", (ctx: Context) => handleReset(ctx));
  bot.command("halt", (ctx: Context) => handleHalt(ctx));
  bot.command("resume", (ctx: Context) => handleResume(ctx));
  bot.command("status", (ctx: Context) => handleStatus(ctx));
  bot.command("budget", (ctx: Context) => handleBudget(ctx));
  bot.command("commands", (ctx: Context) => handleCommands(ctx));

  bot.on("message:text", async (ctx: Context) => {
    const text = ctx.message?.text ?? "";
    if (text.startsWith("/")) return;
    log.info({ from: ctx.from?.id, text: text.slice(0, 80) }, "Message received");
    await runKernelText(ctx, text);
  });

  registerMediaHandlers(bot, runKernelText);

  bot.on("callback_query:data", async (ctx: Context) => {
    const data = ctx.callbackQuery?.data ?? "";
    if (data !== "approve" && data !== "reject") {
      await ctx.answerCallbackQuery({ text: "Unknown action" });
      return;
    }
    const decision = data === "approve" ? "approved" : "rejected";
    await ctx.answerCallbackQuery({ text: decision === "approved" ? "✅ Approved" : "❌ Rejected" });
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
    } catch {
      /* best-effort */
    }
    await resumeKernel(ctx, decision);
  });

  bot.catch((err) => {
    log.error({ err: err.message }, "Unhandled bot error");
  });
}

export async function sendToChat(text: string, parseMode: "HTML" | "Markdown" = "HTML"): Promise<void> {
  const bot = getBot();
  await bot.api.sendMessage(env.TELEGRAM_CHAT_ID, text, { parse_mode: parseMode });
}

export async function startBot(): Promise<void> {
  const bot = getBot();
  registerHandlers(bot);
  log.info("Telegram bot starting (long polling)…");
  bot.start().catch((err) => {
    log.error({ err: (err as Error).message }, "Bot polling crashed");
    process.exit(1);
  });
}

export async function stopBot(): Promise<void> {
  if (_bot) {
    await _bot.stop();
    _bot = undefined;
    log.info("Telegram bot stopped");
  }
}
