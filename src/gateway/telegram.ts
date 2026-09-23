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
import { handleTask, handleNewProject, handleRepoChoice, handleRepoReply } from "./task-command.js";
import { handleMenuCallback } from "./home-menu.js";
import { handleTasks } from "./tasks-command.js";
import {
  handleCsv,
  handleFresh,
  handleGaps,
  handleJobs,
  handleToday,
  type JobsViewDeps,
} from "./jobhunt-view.js";
import { withForcedProfileToken } from "./jobhunt-profile-arg.js";
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

// This bot has exactly one authorized operator: the founder's own chat, the
// same TELEGRAM_CHAT_ID sendToChat() already targets. Anyone else who finds
// the bot (grammy has no built-in allowlist) could otherwise trip the
// semantic router's "engineering" intent and approve their own HITL card —
// nothing else in this file checked who was talking. Dropped silently and
// logged, not replied to: a reply confirms to a stranger that the bot exists
// and is listening.
function isAuthorizedChat(ctx: Context): boolean {
  return String(ctx.chat?.id) === env.TELEGRAM_CHAT_ID;
}

export function registerHandlers(bot: Bot): void {
  bot.use(async (ctx, next) => {
    if (!isAuthorizedChat(ctx)) {
      log.warn({ chatId: ctx.chat?.id, from: ctx.from?.id }, "Ignored update from unauthorized chat");
      return;
    }
    await next();
  });

  bot.command("start", (ctx: Context) => handleStart(ctx));
  bot.command("reset", (ctx: Context) => handleReset(ctx));
  bot.command("halt", (ctx: Context) => handleHalt(ctx));
  bot.command("resume", (ctx: Context) => handleResume(ctx));
  bot.command("status", (ctx: Context) => handleStatus(ctx));
  bot.command("budget", (ctx: Context) => handleBudget(ctx));
  bot.command("connect", (ctx: Context) => handleConnect(ctx));
  bot.command("commands", (ctx: Context) => handleCommands(ctx));
  // The registry read is dynamically imported so this transport file does not pull
  // the database into the bot's startup path (same reason as jobsDeps below).
  // Shared by the command and by the repo buttons it puts on screen: two copies
  // would be two answers to "which repos may I dispatch to", and the button list
  // drifting from the parser's allowlist is a button that refuses its own label.
  const taskDeps = {
    runKernelText,
    listRegisteredRepos: async () => {
      const [{ listRegisteredDispatchRepos }, { TENANT }] = await Promise.all([
        import("../db/queries.js"),
        import("../core/config.js"),
      ]);
      return listRegisteredDispatchRepos(TENANT);
    },
  };
  bot.command("task", (ctx: Context) => handleTask(ctx, taskDeps));
  bot.command("tasks", (ctx: Context) => handleTasks(ctx));
  bot.command("newproject", (ctx: Context) => handleNewProject(ctx, { runKernelText }));
  bot.command("draft", (ctx: Context) => handleDraft(ctx, { runKernelText }));
  bot.command("wife_draft", (ctx: Context) => handleDraft(withForcedProfileToken(ctx, "wife"), { runKernelText }));
  bot.command("ask", (ctx: Context) => handleAsk(ctx, { runKernelText }));
  bot.command("wife_ask", (ctx: Context) => handleAsk(withForcedProfileToken(ctx, "wife"), { runKernelText }));
  bot.command("applied", (ctx: Context) => handleApplied(ctx));
  bot.command("wife_applied", (ctx: Context) => handleApplied(withForcedProfileToken(ctx, "wife")));
  bot.command("replied", (ctx: Context) => handleReplied(ctx));
  bot.command("wife_replied", (ctx: Context) => handleReplied(withForcedProfileToken(ctx, "wife")));
  bot.command("rejected", (ctx: Context) => handleRejected(ctx));
  bot.command("wife_rejected", (ctx: Context) => handleRejected(withForcedProfileToken(ctx, "wife")));
  bot.command("profile", (ctx: Context) => handleProfile(ctx));
  bot.command("wife_profile", (ctx: Context) => handleProfile(withForcedProfileToken(ctx, "wife")));
  // The renderer is dynamically imported so this transport file never pulls the
  // brief's database and liveness dependencies into the bot's startup path.
  // `splitForTelegram` is pure formatting and imported normally.
  const jobsDeps: JobsViewDeps = {
    buildBrief: async (profile, scope) =>
      (await import("../tools/jobhunt/daily-brief.js")).buildDailyBrief({ profile, scope }),
    split: splitForTelegram,
    lastFreshView: async (profileId) =>
      (await import("../db/job-heartbeat-queries.js")).lastFreshView(profileId),
    recordFreshView: async (profileId, at) =>
      (await import("../db/job-heartbeat-queries.js")).recordFreshView(profileId, at),
  };
  bot.command("jobs", (ctx: Context) => handleJobs(ctx, jobsDeps));
  bot.command("wife_jobs", (ctx: Context) => handleJobs(withForcedProfileToken(ctx, "wife"), jobsDeps));
  bot.command("today", (ctx: Context) => handleToday(ctx, jobsDeps));
  bot.command("wife_today", (ctx: Context) => handleToday(withForcedProfileToken(ctx, "wife"), jobsDeps));
  bot.command("fresh", (ctx: Context) => handleFresh(ctx, jobsDeps));
  bot.command("wife_fresh", (ctx: Context) => handleFresh(withForcedProfileToken(ctx, "wife"), jobsDeps));
  bot.command("csv", (ctx: Context) => handleCsv(ctx));
  bot.command("wife_csv", (ctx: Context) => handleCsv(withForcedProfileToken(ctx, "wife")));
  // The other half of /draft. Tailoring may only name technologies the base CV
  // already states, so it cannot raise ATS keyword coverage — this is the ranked
  // list of what to add to the base CV, which is the only thing that can.
  bot.command("gaps", (ctx: Context) => handleGaps(ctx));
  bot.command("wife_gaps", (ctx: Context) => handleGaps(withForcedProfileToken(ctx, "wife")));

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
    // Logged BEFORE the dispatch branch below, so every inbound message appears
    // once regardless of which path it takes — a turn that is only visible in
    // the logs when it went one of two ways is a turn nobody can debug.
    const sentAt = ctx.message?.date ? formatTimestamp(ctx.message.date * 1000) : undefined;
    log.info(
      { from: ctx.from?.id, text: text.slice(0, 80), sentAt, receivedAt: formatTimestamp() },
      "Message received",
    );
    // A reply to "what should I build?" is a dispatch, not a chat turn. Checked
    // before the kernel because the repository he picked lives in the message he
    // replied to — hand it to the planner as ordinary text and that target is
    // just a sentence the model may or may not honour.
    if (await handleRepoReply(ctx, taskDeps)) return;
    await runKernelText(ctx, text);
  });

  registerMediaHandlers(bot, runKernelText);

  bot.on("callback_query:data", async (ctx: Context) => {
    const data = ctx.callbackQuery?.data ?? "";
    // Ordered by how much a mistake costs. Each handler returns false for a
    // payload that is not its own, so the HITL approve/reject path below keeps
    // its exact previous behaviour: it is the one button where a misroute means
    // a side effect fires, or fails to, without the founder knowing which.
    if (await handleRepoChoice(ctx, taskDeps)) return;
    if (await handleMenuCallback(ctx)) return;
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
