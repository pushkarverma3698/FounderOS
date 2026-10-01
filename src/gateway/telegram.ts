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
import { handleWifeCommands } from "./wife-commands.js";
import { handleTask, handleRepoChoice, handleRepoReply } from "./task-command.js";
import { handleFocus, handleProjects } from "./focus-commands.js";
import { handleNewProject } from "./newproject-command.js";
import { handleMenuCallback } from "./home-menu.js";
import { handleTasks, fetchDispatchTasks } from "./tasks-command.js";
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
import { REPO_CALLBACK_PREFIX } from "./repo-picker.js";
import { RETRY_CALLBACK_PREFIX } from "./retry-button.js";
import { handleRetryCallback } from "./retry-callback.js";
import {
  OWNER_ONLY_COMMANDS,
  buildChatAccessConfig,
  classifyChatAccess,
  commandName,
  isAddressedToBot,
  mayActAsOwner,
  openGroupHint,
  stripBotMention,
  type ChatAccessConfig,
} from "./chat-access.js";

// media.ts and tests import safeHtml from here — keep the path stable.
export { safeHtml } from "./approval-card.js";
export { runKernelText, resumeKernel, withChatTurnLock, restorePendingApproval } from "./kernel-run.js";

const log = logger.child({ module: "telegram" });

let _bot: Bot | undefined;

export function getBot(): Bot {
  if (!_bot) _bot = new Bot(env.TELEGRAM_BOT_TOKEN);
  return _bot;
}

// Who may talk to the bot, and where: chat-access.ts. The founder's own chat
// (TELEGRAM_CHAT_ID) is unchanged. Groups used to be dropped wholesale — a
// group has its own chat id — which is why adding the bot to one produced
// silence. Strangers are still dropped silently and logged, not replied to: a
// reply confirms to a stranger that the bot exists and is listening. Anyone
// who is not the founder still cannot approve a HITL card.
function defaultChatAccess(): ChatAccessConfig {
  return buildChatAccessConfig({
    primaryChatId: env.TELEGRAM_CHAT_ID,
    allowedChatIds: env.TELEGRAM_ALLOWED_CHAT_IDS,
    answerAllChatIds: env.TELEGRAM_ANSWER_ALL_CHAT_IDS,
    ownerUserId: env.TELEGRAM_OWNER_USER_ID,
  });
}

/** Buttons whose tap causes a side effect — the founder's alone outside his own chat. Retry re-runs his turn. */
function isDecisionButton(data: string): boolean {
  const prefixes = ["approve", "reject", REPO_CALLBACK_PREFIX, RETRY_CALLBACK_PREFIX];
  return prefixes.some((p) => data.startsWith(p));
}

export function registerHandlers(bot: Bot, access: ChatAccessConfig = defaultChatAccess()): void {
  // Per process: the "how to let the others in" hint is said once per group.
  const hintedGroups = new Set<string>();

  bot.use(async (ctx, next) => {
    const who = classifyChatAccess({ chatId: ctx.chat?.id, chatType: ctx.chat?.type, fromId: ctx.from?.id }, access);
    if (who === "denied") {
      log.warn({ chatId: ctx.chat?.id, chatType: ctx.chat?.type, from: ctx.from?.id }, "Ignored update from unauthorized chat");
      return;
    }
    const msg = ctx.message;
    if (msg && ctx.chat) {
      const me = { id: ctx.me.id, username: ctx.me.username };
      const addressed = isAddressedToBot(
        {
          chatType: ctx.chat.type,
          text: msg.text,
          entities: msg.entities,
          caption: msg.caption,
          captionEntities: msg.caption_entities,
          replyToFromId: msg.reply_to_message?.from?.id,
        },
        me,
      );
      // Group conversation not meant for the bot. The primary chat is exempt even
      // when it is a group: it always answered every message and still does. So
      // is a chat the founder listed in TELEGRAM_ANSWER_ALL_CHAT_IDS.
      if (!addressed && who !== "primary" && !access.answerAllChatIds.has(String(ctx.chat.id))) return;
      const command = msg.text ? commandName(msg.text, me.username) : null;
      if (command !== null && OWNER_ONLY_COMMANDS.has(command) && !mayActAsOwner(who, ctx.from?.id, access)) {
        await ctx.reply(`Only the owner can run /${command}.`);
        return;
      }
      if (who === "owner-in-group" && !hintedGroups.has(String(ctx.chat.id))) {
        hintedGroups.add(String(ctx.chat.id));
        // allow-failopen: the hint is advice; failing to send it must not cost the founder the turn he asked for.
        await ctx.reply(openGroupHint(ctx.chat.id), { parse_mode: "HTML" }).catch(() => undefined);
      }
    }
    const tapped = ctx.callbackQuery?.data ?? "";
    if (tapped && isDecisionButton(tapped) && !mayActAsOwner(who, ctx.from?.id, access)) {
      await ctx.answerCallbackQuery({ text: "Only the owner can approve or dispatch this." });
      return;
    }
    await next();
  });

  bot.command("start", (ctx: Context) => handleStart(ctx));
  bot.command("reset", (ctx: Context) => handleReset(ctx));
  bot.command("halt", (ctx: Context) => handleHalt(ctx));
  bot.command("resume", (ctx: Context) => handleResume(ctx));
  bot.command("status", (ctx: Context) => handleStatus(ctx));
  bot.command("focus", (ctx: Context) => handleFocus(ctx));
  bot.command("projects", (ctx: Context) => handleProjects(ctx));
  bot.command("budget", (ctx: Context) => handleBudget(ctx));
  bot.command("connect", (ctx: Context) => handleConnect(ctx));
  bot.command("commands", (ctx: Context) => handleCommands(ctx));
  bot.command("remind", (ctx: Context) => {
    const text = ctx.match?.toString().trim();
    if (!text) {
      void ctx.reply("Usage: /remind <what and when>\n\nExample: /remind call the landlord at 3pm");
      return;
    }
    return runKernelText(ctx, `Remind me ${text}`);
  });
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
  bot.command("tasks", (ctx: Context) => handleTasks(ctx, {
    fetch: (repos) => fetchDispatchTasks(repos),
    listRegisteredRepos: taskDeps.listRegisteredRepos,
  }));
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
  bot.command("wife_commands", (ctx: Context) => handleWifeCommands(ctx)); // the wife_ aliases are out of the ☰ menu

  bot.on("message:text", async (ctx: Context) => {
    const raw = ctx.message?.text ?? "";
    // In a group the middleware only lets addressed messages through, and
    // "@founderos_bot show jobs" should reach the kernel as "show jobs".
    const text = ctx.chat?.type === "private" ? raw : stripBotMention(raw, ctx.me.username);
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
    if (await handleRetryCallback(ctx)) return;
    if (!data.startsWith("approve") && !data.startsWith("reject")) {
      await ctx.answerCallbackQuery({ text: "Unknown action" });
      return;
    }
    const decision = data.startsWith("approve") ? "approved" : "rejected";
    const nonceMatch = data.match(/:(.+)$/);
    const nonce = nonceMatch ? nonceMatch[1] : undefined;
    await ctx.answerCallbackQuery({ text: decision === "approved" ? "✅ Approved" : "❌ Rejected" });
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
    } catch {
      /* best-effort */
    }
    await resumeKernel(ctx, decision, nonce);
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
    const payload = telegramCommandPayload();
    await bot.api.setMyCommands(payload);
    log.info({ count: payload.length, hiddenAliases: COMMAND_MENU.length - payload.length }, "Telegram command menu published");
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
