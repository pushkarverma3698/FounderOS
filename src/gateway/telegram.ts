/**
 * FounderOS v2 — Telegram Gateway
 * ================================
 * Bot lifecycle + handler registration. The actual office run-loop (the
 * highest-risk logic: interrupt/wedge guards, turn slicing, history trimming,
 * resume) lives in ./office-run.ts so it can be read and unit-tested on its own.
 *
 * This file wires Telegram events to that loop:
 *   /command           → handlers in ./commands.js
 *   message:text       → routeToOffice → runOfficeText
 *   photo/voice/audio  → media handlers (./media.js)
 *   callback (approve) → resumeOffice
 *
 * Thread id = `turicks:{chatId}` — stable per chat so conversation memory
 * persists and the approval button can resume the exact paused run.
 *
 * The run-loop symbols (safeHtml, finalReply, collectToolErrors,
 * sliceFreshMessages, resolvePendingApproval, trimThreadHistory) are re-exported
 * below so existing importers (tests, media.ts) keep using "./telegram.js".
 */

import { Bot, type Context } from "grammy";
import { env } from "../core/config.js";
import { logger } from "../infra/logger.js";
import {
  handleStart, handleReset, handleStatus, handleContext,
  handleTarget, handleTargets, handleUntarget,
  handleOutbound, handleCommands, handleDepartments,
  handleWorkflows, handleRun, handleQ,
  handleHalt, handleResume,
} from "./commands.js";
import { registerMediaHandlers } from "./media.js";
import { routeToOffice, runOfficeText, resumeOffice } from "./office-run.js";

// Re-export run-loop helpers so tests and media.ts can keep importing from here.
export {
  safeHtml,
  finalReply,
  collectToolErrors,
  sliceFreshMessages,
  resolvePendingApproval,
  recoverWedgedThread,
  trimThreadHistory,
  runOfficeText,
  resumeOffice,
  formatApprovalCard,
  restorePendingApprovalAfterRestart,
  withChatTurnLock,
  clearStalePendingInterruptOnBoot,
} from "./office-run.js";

const log = logger.child({ module: "telegram" });

// ── Bot singleton ──────────────────────────────────────────────────────────────

let _bot: Bot | undefined;

export function getBot(): Bot {
  if (!_bot) _bot = new Bot(env.TELEGRAM_BOT_TOKEN);
  return _bot;
}

// ── Handlers ───────────────────────────────────────────────────────────────────

export function registerHandlers(bot: Bot): void {
  // Command handlers are implemented in commands.ts (extracted for testability).
  // This file stays focused on bot lifecycle + message/callback routing.
  bot.command("start",       (ctx: Context) => handleStart(ctx));
  bot.command("reset",       (ctx: Context) => handleReset(ctx));
  // Kill switch — refuse all new turns / approvals until lifted.
  bot.command("halt",        (ctx: Context) => handleHalt(ctx));
  bot.command("resume",      (ctx: Context) => handleResume(ctx));
  bot.command("status",      (ctx: Context) => handleStatus(ctx));
  bot.command("context",     (ctx: Context) => handleContext(ctx));
  bot.command("target",      (ctx: Context) => handleTarget(ctx));
  bot.command("targets",     (ctx: Context) => handleTargets(ctx));
  bot.command("untarget",    (ctx: Context) => handleUntarget(ctx));
  bot.command("outbound",    (ctx: Context) => handleOutbound(ctx, runOfficeText));
  bot.command("commands",    (ctx: Context) => handleCommands(ctx));
  bot.command("departments", (ctx: Context) => handleDepartments(ctx));
  // Phase 1 — Workflow / SOP engine
  bot.command("workflows",   (ctx: Context) => handleWorkflows(ctx));
  bot.command("run",         (ctx: Context) => handleRun(ctx, runOfficeText));
  // Phase 2 — Power-user direct-to-dept bypass
  bot.command("q",           (ctx: Context) => handleQ(ctx, runOfficeText));

  // ── Free-text messages → office ────────────────────────────────────────────

  bot.on("message:text", async (ctx: Context) => {
    const text = ctx.message?.text ?? "";
    if (text.startsWith("/")) return; // ignore other slash commands for now
    log.info({ from: ctx.from?.id, text: text.slice(0, 80) }, "Message received");
    await routeToOffice(ctx);
  });

  // ── Media: photos → image translation; voice/audio → voice commands ────────
  registerMediaHandlers(bot, runOfficeText);

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
    await resumeOffice(ctx, decision);
  });

  bot.catch((err) => {
    log.error({ err: err.message }, "Unhandled bot error");
  });
}

// ── Plain sender (used by schedulers/agents to push a message) ─────────────────

export async function sendToChat(text: string, parseMode: "HTML" | "Markdown" = "HTML"): Promise<void> {
  const bot = getBot();
  await bot.api.sendMessage(env.TELEGRAM_CHAT_ID, text, { parse_mode: parseMode });
}

// ── Lifecycle ───────────────────────────────────────────────────────────────────

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
