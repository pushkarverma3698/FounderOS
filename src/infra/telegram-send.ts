/**
 * FounderOS — Telegram Send (infra)
 * ==================================
 * A thin, api-only Telegram client for sending OUT of agent tools without
 * importing the gateway (agents must not depend on gateway — that would be a
 * circular import). It uses grammy's `bot.api` directly and NEVER starts long
 * polling, so it cannot conflict with the gateway's single poll loop (no 409).
 *
 * Used by the `send_file` personal tool to attach a laptop file to the founder's
 * Telegram chat after HITL approval.
 */

import { Bot, InputFile, type Api } from "grammy";
import { env } from "../core/config.js";
import { resolveJobsBotToken } from "./jobs-bot-token.js";
import { childLogger } from "./logger.js";
import { installScreenCapture } from "./screen-log.js";

const log = childLogger({ module: "telegram-send" });

let _bot: Bot | undefined;

/** Lazy api-only bot singleton (constructed from the validated token). Its sends go to the screen log. */
function api() {
  if (!_bot) {
    _bot = new Bot(resolveJobsBotToken().token);
    installScreenCapture(_bot.api, "bot");
  }
  return _bot.api;
}

/** The founder's default chat id (single-tenant). */
function defaultChatId(): string {
  return env.TELEGRAM_CHAT_ID;
}

/**
 * Push a message to the founder's chat (used by the scheduler — Monday brief,
 * HITL sweeper). Api-only: never starts long polling, so it cannot conflict with
 * the gateway's single poll loop. Keeping it here (infra) lets the scheduler stay
 * within its layer instead of importing the gateway (infra → gateway is illegal).
 */
export async function sendToChat(
  text: string,
  parseMode: "HTML" | "Markdown" = "HTML",
): Promise<void> {
  await api().sendMessage(defaultChatId(), text, { parse_mode: parseMode });
}

/**
 * Where job-lane messages go: the family jobs group when JOBHUNT_CHAT_ID is set, else the founder's chat.
 * Budget alerts, approvals and dispatch notices keep using `sendToChat`, so the group carries jobs only.
 * Read from the environment at call time, like the job lane's other optional knobs (JOBHUNT_MONTHLY_CAP_USD in
 * spend-gate.ts): optional, with a safe default, and src/core/config.ts is at its line budget.
 */
export function jobsChatId(): string {
  return process.env["JOBHUNT_CHAT_ID"]?.trim() || defaultChatId();
}

interface TelegramRefusal {
  readonly error_code?: unknown;
  readonly description?: unknown;
  readonly parameters?: { readonly migrate_to_chat_id?: unknown };
}

/** 400 refusals that say the chat itself is gone or closed to the bot, as opposed to a bad message. */
const CHAT_GONE = /chat not found|upgraded to a supergroup|rights to send|no write access|chat_write_forbidden|chat was deactivated/i;

/**
 * Did Telegram refuse because THE CHAT cannot be reached (the bot was removed, blocked or muted, or the
 * group was upgraded to a supergroup and got a new id)? A bad message (parse error, too long), a rate
 * limit and a network failure are not that, and are the caller's to handle.
 */
export function isChatUnreachable(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const { error_code: code, description } = err as TelegramRefusal;
  if (code === 403) return true;
  return code === 400 && typeof description === "string" && CHAT_GONE.test(description);
}

function unreachableNotice(err: unknown): string {
  const { description, parameters } = err as TelegramRefusal;
  const reason = typeof description === "string" ? description : err instanceof Error ? err.message : String(err);
  const moved = parameters?.migrate_to_chat_id;
  return (
    `⚠ I could not post to the jobs group (${reason}). Job messages are coming here until that is fixed.` +
    (moved !== undefined ? ` Telegram gave the group a new id: set JOBHUNT_CHAT_ID=${String(moved)} on the server and restart.` : "")
  );
}

/**
 * Send a job-lane message to the jobs chat (JOBHUNT_CHAT_ID), the way `sendToChat` sends to the founder.
 *
 * When Telegram says that chat cannot be reached, the message goes to the founder's chat instead, after a
 * notice naming the cause. Without that, a broken group looks exactly like a quiet job market: the sweeps
 * log the failure and nobody reads the log. Every other failure reaches the caller unchanged, so the
 * callers' send-first, record-on-success handling is as it was.
 */
export async function sendToJobsChat(
  text: string,
  parseMode: "HTML" | "Markdown" = "HTML",
  keyboard: readonly (readonly { readonly text: string; readonly callback_data: string }[])[] = [],
): Promise<void> {
  const target = jobsChatId();
  const markup = keyboard.length > 0 ? { reply_markup: { inline_keyboard: keyboard.map((row) => row.map((b) => ({ ...b }))) } } : {};
  try {
    await api().sendMessage(target, text, { parse_mode: parseMode, ...markup });
  } catch (err) {
    if (target === defaultChatId() || !isChatUnreachable(err)) throw err;
    log.error(
      { target, err: err instanceof Error ? err.message : String(err) },
      "Jobs chat unreachable — sending this job message to the founder's chat",
    );
    // Two sends, the notice as plain text: the reason comes from Telegram and must not be able to break
    // an HTML parse, and the job message keeps its own formatting.
    await api().sendMessage(defaultChatId(), unreachableNotice(err));
    await api().sendMessage(defaultChatId(), text, { parse_mode: parseMode, ...markup });
  }
}

/**
 * `sendToChat` with an inline keyboard (the goal standup's "Plan next step" buttons). Same api-only
 * client, so it still cannot conflict with the gateway's poll loop. No `reply_markup` is sent for an
 * empty keyboard. A delivery failure reaches the caller: the standup decides whether to retry.
 */
export async function sendToChatWithKeyboard(
  text: string,
  keyboard: readonly (readonly { readonly text: string; readonly callback_data: string }[])[],
  parseMode: "HTML" | "Markdown" = "HTML",
): Promise<void> {
  await api().sendMessage(defaultChatId(), text, {
    parse_mode: parseMode,
    ...(keyboard.length > 0 ? { reply_markup: { inline_keyboard: keyboard.map((row) => row.map((b) => ({ ...b }))) } } : {}),
  });
}

/**
 * Send an in-memory image as a Telegram photo.
 *
 * Takes a Buffer, not a path — `apply_headless`'s screenshot never touches
 * disk, so there is nothing to path-guard and nothing to clean up after. Used
 * for the filled-form preview: informational, like `sendDocument`, not gated
 * behind HITL — showing the founder what a form looks like is not an external
 * action on his behalf, only telling him about a submit click is.
 */
export async function sendPhoto(
  png: Buffer,
  opts: { chatId?: string | number; caption?: string; filename?: string } = {},
): Promise<void> {
  const chatId = opts.chatId ?? defaultChatId();
  await api().sendPhoto(chatId, new InputFile(png, opts.filename ?? "form-preview.png"), {
    ...(opts.caption ? { caption: opts.caption } : {}),
  });
  log.info({ chatId, bytes: png.length }, "Photo sent to Telegram");
}

/**
 * Send a message to an explicit chat with grammy's own send options (parse mode, keyboard, link preview).
 * Used by the apply answer page to deliver the refreshed card to the chat that started the apply, from an
 * HTTP request with no Telegram context. A delivery failure reaches the caller, which decides what to do.
 */
export async function sendMessageTo(chatId: string | number, text: string, other?: Parameters<Api["sendMessage"]>[2]): Promise<void> {
  await api().sendMessage(chatId, text, other);
}
