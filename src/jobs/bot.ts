/**
 * The jobs bot (2026-10-10): Telegram for the standalone jobs process.
 *
 * Commands only. The job commands, their wife_ aliases, /start, /commands and the
 * jh: buttons. There is no kernel behind it any more, so free text gets a one-line
 * hint instead of a model turn, and an unknown /command says so instead of going silent.
 *
 * Access rules are unchanged from the retired gateway (chat-access.ts): strangers are
 * dropped and logged, a group hears only messages addressed to the bot, and a sender
 * listed in JOBHUNT_SENDER_PROFILES gets their own profile word injected.
 */
import { Bot, type Context } from "grammy";
import { env } from "../core/config.js";
import { logger } from "../infra/logger.js";
import { resolveJobsBotToken } from "../infra/jobs-bot-token.js";
import { handleDraft, handleApplied } from "../gateway/jobhunt-commands.js";
import { injectSenderProfile, parseSenderProfiles } from "../gateway/jobhunt-sender-profile.js";
import { handleJobCallback } from "../gateway/jobhunt-callbacks.js";
import { handleReplied, handleRejected } from "../gateway/live-application-commands.js";
import { handleProfile } from "../gateway/profile-commands.js";
import { handleWifeCommands } from "../gateway/wife-commands.js";
import { handleCsv, handleFresh, handleGaps, handleJobs, handleToday, type JobsViewDeps } from "../gateway/jobhunt-view.js";
import { withForcedProfileToken } from "../gateway/jobhunt-profile-arg.js";
import { COMMAND_MENU, buildCommandsHelp, telegramCommandPayload } from "../gateway/command-menu.js";
import { splitForTelegram } from "../tools/jobhunt/telegram-format.js";
import { isConflictError, conflictBackoffMs, CONFLICT_MAX_ATTEMPTS } from "../gateway/telegram-poll.js";
import {
  buildChatAccessConfig,
  classifyChatAccess,
  commandName,
  isAddressedToBot,
  openGroupHint,
  stripBotMention,
  type ChatAccessConfig,
} from "../gateway/chat-access.js";

const log = logger.child({ module: "jobs-bot" });

/** The structural slice of grammy's Bot this file registers on (tests pass a fake). */
type Registrar = Pick<Bot, "use" | "command" | "on" | "catch">;

function defaultChatAccess(): ChatAccessConfig {
  return buildChatAccessConfig({
    primaryChatId: env.TELEGRAM_CHAT_ID,
    allowedChatIds: env.TELEGRAM_ALLOWED_CHAT_IDS,
    answerAllChatIds: env.TELEGRAM_ANSWER_ALL_CHAT_IDS,
    ownerUserId: env.TELEGRAM_OWNER_USER_ID,
  });
}

/** The brief renderer and fresh-view clock, imported lazily so startup does not open them. */
const jobsDeps: JobsViewDeps = {
  buildBrief: async (profile, scope) =>
    // No weeklyGoal: it was read from the goals table, which prod never had (checked 2026-10-10).
    (await import("../tools/jobhunt/daily-brief.js")).buildDailyBrief({ profile, scope }),
  split: splitForTelegram,
  topRoles: async (profile) => (await import("../gateway/jobhunt-compact.js")).topRolesFor(profile),
  lastFreshView: async (profileId) => (await import("../db/job-heartbeat-queries.js")).lastFreshView(profileId),
  recordFreshView: async (profileId, at) => (await import("../db/job-heartbeat-queries.js")).recordFreshView(profileId, at),
};

async function replyHelp(ctx: Context): Promise<void> {
  for (const part of buildCommandsHelp()) await ctx.reply(part, { parse_mode: "HTML" });
}

/** A command plus its wife_ twin, which runs the same handler against Tashi's profile. */
function both(bot: Registrar, name: string, handler: (ctx: Context) => Promise<unknown>): void {
  bot.command(name, (ctx: Context) => handler(ctx));
  bot.command(`wife_${name}`, (ctx: Context) => handler(withForcedProfileToken(ctx, "wife")));
}

export function registerJobsHandlers(bot: Registrar, access: ChatAccessConfig = defaultChatAccess()): void {
  const hintedGroups = new Set<string>(); // the "how to let the others in" hint, once per group per process
  const senderProfiles = parseSenderProfiles(env.JOBHUNT_SENDER_PROFILES);

  bot.use(async (ctx, next) => {
    const who = classifyChatAccess({ chatId: ctx.chat?.id, chatType: ctx.chat?.type, fromId: ctx.from?.id }, access);
    if (who === "denied") {
      log.warn({ chatId: ctx.chat?.id, chatType: ctx.chat?.type, from: ctx.from?.id }, "Ignored update from unauthorized chat");
      return;
    }
    const msg = ctx.message;
    const senderProfile = ctx.from ? senderProfiles.get(ctx.from.id) : undefined;
    if (msg?.text && senderProfile) msg.text = injectSenderProfile(msg.text, senderProfile);
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
      // Group talk not meant for the bot. The primary chat and TELEGRAM_ANSWER_ALL_CHAT_IDS are exempt.
      if (!addressed && who !== "primary" && !access.answerAllChatIds.has(String(ctx.chat.id))) return;
      if (who === "owner-in-group" && !hintedGroups.has(String(ctx.chat.id))) {
        hintedGroups.add(String(ctx.chat.id));
        // allow-failopen: the hint is advice; failing to send it must not cost the founder the command he sent.
        await ctx.reply(openGroupHint(ctx.chat.id), { parse_mode: "HTML" }).catch(() => undefined);
      }
    }
    await next();
  });

  bot.command("start", (ctx: Context) => replyHelp(ctx));
  bot.command("commands", (ctx: Context) => replyHelp(ctx));
  bot.command("wife_commands", (ctx: Context) => handleWifeCommands(ctx)); // the wife_ aliases are out of the ☰ menu

  both(bot, "draft", (ctx) => handleDraft(ctx));
  both(bot, "applied", (ctx) => handleApplied(ctx));
  both(bot, "replied", (ctx) => handleReplied(ctx));
  both(bot, "rejected", (ctx) => handleRejected(ctx));
  both(bot, "profile", (ctx) => handleProfile(ctx));
  both(bot, "jobs", (ctx) => handleJobs(ctx, jobsDeps));
  both(bot, "today", (ctx) => handleToday(ctx, jobsDeps));
  both(bot, "fresh", (ctx) => handleFresh(ctx, jobsDeps));
  both(bot, "csv", (ctx) => handleCsv(ctx));
  // /draft can only use words the base CV already has; this is the list of what to add to it.
  both(bot, "gaps", (ctx) => handleGaps(ctx));

  bot.on("message:text", async (ctx: Context) => {
    const raw = ctx.message?.text ?? "";
    const text = ctx.chat?.type === "private" ? raw : stripBotMention(raw, ctx.me.username);
    if (!text.trim()) return;
    log.info({ from: ctx.from?.id, chat: ctx.chat?.id, text: text.slice(0, 80) }, "Unhandled text");
    // Registered commands never reach here, so a /word is one that does not exist. Silence would read as a dead bot.
    const typed = text.trim().split(/\s+/)[0] ?? "";
    const isCommand = commandName(text, ctx.me.username) !== null;
    await ctx.reply(
      isCommand
        ? `${typed} isn't a command I know. /commands lists them.`
        : "I answer job commands only, for example /fresh, /jobs or /draft 1. /commands lists them.",
    );
  });

  bot.on("callback_query:data", async (ctx: Context) => {
    if (await handleJobCallback(ctx, jobsDeps)) return;
    await ctx.answerCallbackQuery({ text: "Unknown action" });
  });

  bot.catch((err) => {
    log.error({ err: err.message }, "Unhandled bot error");
  });
}

/**
 * Poll until stopped, surviving a transient 409 (another getUpdates consumer, e.g. the
 * old process still draining during a deploy). Every other polling failure exits at once:
 * an expired token does not heal by waiting.
 */
async function pollUntilStopped(bot: Bot, sleep: (ms: number) => Promise<void>): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      log.info("Jobs bot starting (long polling)");
      await bot.start();
      return; // clean shutdown via stopJobsBot()
    } catch (err) {
      if (!isConflictError(err)) {
        log.error({ err: (err as Error).message }, "Bot polling crashed");
        process.exit(1);
      }
      if (attempt >= CONFLICT_MAX_ATTEMPTS) {
        log.error({ attempts: attempt, err: (err as Error).message }, "Another getUpdates consumer still holds this token, exiting");
        process.exit(1);
      }
      const waitMs = conflictBackoffMs(attempt);
      log.warn({ attempt, maxAttempts: CONFLICT_MAX_ATTEMPTS, waitMs }, "Another getUpdates consumer holds this token, backing off");
      // allow-failopen: stopping a runner that never started throws; the retry is the recovery, and the attempt cap still exits.
      await bot.stop().catch(() => undefined);
      await sleep(waitMs);
    }
  }
}

/** The ☰ menu. Best-effort: every command works without it, so a failure is a warning, not a crash. */
async function publishCommandMenu(bot: Bot): Promise<void> {
  try {
    const payload = telegramCommandPayload();
    await bot.api.setMyCommands(payload);
    log.info({ count: payload.length, hiddenAliases: COMMAND_MENU.length - payload.length }, "Telegram command menu published");
  } catch (err) {
    log.warn({ err: (err as Error).message }, "Could not publish the command menu, commands still work");
  }
}

let _bot: Bot | undefined;

export async function startJobsBot(): Promise<void> {
  _bot = new Bot(resolveJobsBotToken().token);
  registerJobsHandlers(_bot);
  await publishCommandMenu(_bot);
  void pollUntilStopped(_bot, (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
}

export async function stopJobsBot(): Promise<void> {
  if (!_bot) return;
  await _bot.stop();
  _bot = undefined;
  log.info("Jobs bot stopped");
}
