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
import { formatTimestamp } from "../infra/timestamp.js";
import {
  handleStart,
  handleReset,
  handleStatus,
  handleBudget,
  handleHalt,
  handleResume,
  handleCommands,
  handleConnect,
  unknownCommandReply,
} from "./commands.js";
import { handleAsk, handleDraft, handleApplied } from "./jobhunt-commands.js";
import { handleReplied, handleRejected } from "./live-application-commands.js";
import { handleProfile } from "./profile-commands.js";
import { handleCsv, handleJobs } from "./jobhunt-view.js";
import { COMMAND_MENU, telegramCommandPayload } from "./command-menu.js";
import { splitForTelegram } from "../tools/jobhunt/telegram-format.js";
import { registerMediaHandlers } from "./media.js";
import { runKernelText, resumeKernel } from "./kernel-run.js";
import { isConflictError, conflictBackoffMs, CONFLICT_MAX_ATTEMPTS } from "./telegram-poll.js";

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
  bot.command("connect", (ctx: Context) => handleConnect(ctx));
  bot.command("commands", (ctx: Context) => handleCommands(ctx));
  bot.command("draft", (ctx: Context) => handleDraft(ctx, { runKernelText }));
  bot.command("ask", (ctx: Context) => handleAsk(ctx, { runKernelText }));
  bot.command("applied", (ctx: Context) => handleApplied(ctx));
  bot.command("replied", (ctx: Context) => handleReplied(ctx));
  bot.command("rejected", (ctx: Context) => handleRejected(ctx));
  bot.command("profile", (ctx: Context) => handleProfile(ctx));
  // The renderer is dynamically imported so this transport file never pulls the
  // brief's database and liveness dependencies into the bot's startup path.
  // `splitForTelegram` is pure formatting and imported normally.
  bot.command("jobs", (ctx: Context) =>
    handleJobs(ctx, {
      buildBrief: async (profile) =>
        (await import("../tools/jobhunt/daily-brief.js")).buildDailyBrief({ profile }),
      split: splitForTelegram,
    }),
  );
  bot.command("csv", (ctx: Context) => handleCsv(ctx));

  bot.on("message:text", async (ctx: Context) => {
    const text = ctx.message?.text ?? "";
    if (text.startsWith("/")) {
      // Registered commands never reach here (grammy matched them first), so
      // anything left is one the founder typed that does not exist. Returning
      // silently is the worst available answer: he acted, and the system gave
      // no sign it had heard him. /draft 1 read exactly like a dead bot.
      await ctx.reply(unknownCommandReply(text));
      return;
    }
    if (!text.trim()) return; // ignore empty / whitespace-only messages
    // Telegram `message.date` is epoch SECONDS (the send time); receivedAt is
    // our clock. Both formatted to readable UTC so logs never show a raw epoch.
    const sentAt = ctx.message?.date ? formatTimestamp(ctx.message.date * 1000) : undefined;
    log.info(
      { from: ctx.from?.id, text: text.slice(0, 80), sentAt, receivedAt: formatTimestamp() },
      "Message received",
    );
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

/**
 * Poll until stopped, surviving a transient 409.
 *
 * A 409 says another consumer holds the token. Exiting on it — which is what
 * this used to do — hands the problem to `Restart=always` and produces a crash
 * loop rather than a recovery; 2026-08-08/09 cost 29 restarts that way. Every
 * OTHER polling failure is still fatal on the first occurrence: an expired
 * token or a DNS failure does not heal by waiting, and a bot that quietly
 * retries forever is indistinguishable from a bot nobody is running.
 */
async function pollUntilStopped(bot: Bot, sleep: (ms: number) => Promise<void>): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      log.info("Telegram bot starting (long polling)…");
      await bot.start();
      return; // clean shutdown via stopBot()
    } catch (err) {
      if (!isConflictError(err)) {
        log.error({ err: (err as Error).message }, "Bot polling crashed");
        process.exit(1);
      }
      if (attempt >= CONFLICT_MAX_ATTEMPTS) {
        log.error(
          { attempts: attempt, err: (err as Error).message },
          "Another getUpdates consumer still holds this bot token after every retry — exiting loudly rather than sitting silent",
        );
        process.exit(1);
      }
      const waitMs = conflictBackoffMs(attempt);
      log.warn(
        { attempt, maxAttempts: CONFLICT_MAX_ATTEMPTS, waitMs },
        "Another getUpdates consumer holds this bot token — backing off, not exiting",
      );
      // The runner is left half-started by a failed start(); reset it before
      // retrying or grammY rejects the next start() as "already running".
      // allow-failopen: stopping a runner that never started throws, and that throw must not mask the conflict being handled — the retry is the recovery, and an unusable bot still exits at the attempt cap.
      await bot.stop().catch(() => undefined);
      await sleep(waitMs);
    }
  }
}

/**
 * Publish the ☰ menu Telegram renders next to the message box.
 *
 * Best-effort on purpose. This is discoverability, not function: every command
 * still works if the call fails, and a bot that refuses to start because it
 * could not update a menu is strictly worse than one with a stale menu. Logged
 * at warn so a persistent failure is still visible rather than assumed.
 */
async function publishCommandMenu(bot: Bot): Promise<void> {
  try {
    await bot.api.setMyCommands(telegramCommandPayload());
    log.info({ count: COMMAND_MENU.length }, "Telegram command menu published");
  } catch (err) {
    log.warn({ err: (err as Error).message }, "Could not publish the command menu — commands still work");
  }
}

export async function startBot(): Promise<void> {
  const bot = getBot();
  registerHandlers(bot);
  await publishCommandMenu(bot);
  void pollUntilStopped(bot, (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
}

export async function stopBot(): Promise<void> {
  if (_bot) {
    await _bot.stop();
    _bot = undefined;
    log.info("Telegram bot stopped");
  }
}
