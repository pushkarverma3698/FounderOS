/**
 * FounderOS — run a slash command the planner chose
 * ==================================================
 * The kernel only NAMES the command (`PlannedCommand`); this runs it. It feeds the
 * founder's own message back through the bot as if he had typed `/name args`, so the real
 * handler, the owner-only check and the group-addressing rules apply exactly as they do
 * to a typed command — there is no second table of handlers to drift from telegram.ts.
 *
 * Read-only commands run at once. Everything else posts a card with ✅ Run / ✖ Cancel and
 * runs only on the tap (the planner's reading of a sentence is a guess; the tap is the
 * founder's yes). Pending cards live in memory for 10 minutes: a restart drops them and
 * the founder is told to say it again, which is the safe direction.
 *
 * Callers invoke this AFTER the kernel turn's chat lock is released: commands such as
 * /task start turns of their own and would otherwise wait on a lock this one still holds.
 */

import { InlineKeyboard, type Bot, type Context } from "grammy";
import type { Update } from "grammy/types";
import { randomBytes } from "node:crypto";
import type { PlannedCommand } from "../kernel/index.js";
import { needsConfirmation } from "./command-catalog.js";
import { esc } from "../tools/jobhunt/telegram-format.js";
import { logger } from "../infra/logger.js";

const log = logger.child({ module: "command-dispatch" });

export const COMMAND_CALLBACK_PREFIX = "cmd:";
const PENDING_TTL_MS = 10 * 60 * 1000;

/** Who said it and where — the pieces of the founder's message a command handler reads. */
interface Origin {
  messageId: number;
  chat: NonNullable<Context["chat"]>;
  from: NonNullable<Context["from"]>;
  threadId?: number;
}

const pending = new Map<string, { command: PlannedCommand; origin: Origin; expires: number }>();
let botRef: Bot | undefined;

/** Called once from registerHandlers: the dispatcher needs the bot to re-enter its handlers. */
export function registerCommandDispatch(bot: Bot): void {
  botRef = bot;
}

export function commandText(command: PlannedCommand): string {
  return `/${command.name}${command.args ? ` ${command.args}` : ""}`;
}

/** The update Telegram would have sent had the founder typed the command himself. Pure. */
export function syntheticCommandUpdate(origin: Origin, command: PlannedCommand): Update {
  return {
    update_id: Date.now(),
    message: {
      message_id: origin.messageId,
      date: Math.floor(Date.now() / 1000),
      chat: origin.chat,
      from: origin.from,
      ...(origin.threadId !== undefined ? { message_thread_id: origin.threadId } : {}),
      text: commandText(command),
      entities: [{ type: "bot_command", offset: 0, length: command.name.length + 1 }],
    },
  } as Update;
}

function originOf(ctx: Context): Origin | null {
  if (!ctx.chat || !ctx.from) return null;
  return {
    messageId: ctx.message?.message_id ?? 0,
    chat: ctx.chat,
    from: ctx.from,
    ...(ctx.message?.message_thread_id !== undefined ? { threadId: ctx.message.message_thread_id } : {}),
  };
}

async function execute(origin: Origin, command: PlannedCommand): Promise<void> {
  if (!botRef) throw new Error("command dispatch used before registerCommandDispatch");
  log.info({ command: commandText(command).slice(0, 120), chatId: origin.chat.id }, "Plain words routed to a command");
  await botRef.handleUpdate(syntheticCommandUpdate(origin, command));
}

function prune(now: number): void {
  for (const [id, p] of pending) if (p.expires <= now) pending.delete(id);
}

/** Run the planner's chosen command now (read-only) or after a tap (anything that changes something). */
export async function runPlannedCommand(ctx: Context, command: PlannedCommand): Promise<void> {
  const origin = originOf(ctx);
  if (!origin) return;
  if (!needsConfirmation(command.name, command.args)) {
    await execute(origin, command);
    return;
  }
  prune(Date.now());
  const id = randomBytes(4).toString("hex");
  pending.set(id, { command, origin, expires: Date.now() + PENDING_TTL_MS });
  await ctx.reply(`Run this?\n<code>${esc(commandText(command))}</code>`, {
    parse_mode: "HTML",
    reply_markup: new InlineKeyboard()
      .text("✅ Run", `${COMMAND_CALLBACK_PREFIX}run:${id}`)
      .text("✖ Cancel", `${COMMAND_CALLBACK_PREFIX}no:${id}`),
  });
}

/** The ✅ Run / ✖ Cancel buttons. False when the payload is not ours. */
export async function handleCommandCallback(ctx: Context): Promise<boolean> {
  const data = ctx.callbackQuery?.data ?? "";
  if (!data.startsWith(COMMAND_CALLBACK_PREFIX)) return false;
  const [verb, id] = data.slice(COMMAND_CALLBACK_PREFIX.length).split(":");
  const entry = id ? pending.get(id) : undefined;
  // The card replays the command with the asker's identity, so only the asker may tap it.
  // Checked before the card is spent: a stranger's tap must not use up the owner's button.
  if (entry && ctx.from?.id !== entry.origin.from.id) {
    await ctx.answerCallbackQuery({ text: "Only the person who asked can do that." });
    return true;
  }
  if (id) pending.delete(id); // one tap, one run: a double tap finds nothing
  await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => undefined); // allow-failopen: cosmetic — the buttons are already spent
  if (!entry || entry.expires <= Date.now()) {
    await ctx.answerCallbackQuery({ text: "Expired — say it again." });
    return true;
  }
  if (verb !== "run") {
    await ctx.answerCallbackQuery({ text: "Cancelled" });
    return true;
  }
  await ctx.answerCallbackQuery({ text: "Running" });
  await execute(entry.origin, entry.command);
  return true;
}
