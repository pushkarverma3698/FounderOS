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

import { Bot, InputFile } from "grammy";
import { env } from "../core/config.js";
import { childLogger } from "./logger.js";

const log = childLogger({ module: "telegram-send" });

let _bot: Bot | undefined;

/** Lazy api-only bot singleton (constructed from the validated token). */
function api() {
  if (!_bot) _bot = new Bot(env.TELEGRAM_BOT_TOKEN);
  return _bot.api;
}

/** The founder's default chat id (single-tenant). */
export function defaultChatId(): string {
  return env.TELEGRAM_CHAT_ID;
}

/**
 * Send a file from disk to a Telegram chat as a document attachment.
 * @param chatId  target chat (defaults to the founder's chat)
 * @param absPath absolute path to the file (already path-guard-validated)
 * @param filename display name for the attachment
 * @param caption optional caption
 */
export async function sendDocument(
  absPath: string,
  filename: string,
  opts: { chatId?: string | number; caption?: string } = {},
): Promise<void> {
  const chatId = opts.chatId ?? defaultChatId();
  await api().sendDocument(chatId, new InputFile(absPath, filename), {
    ...(opts.caption ? { caption: opts.caption } : {}),
  });
  log.info({ chatId, filename }, "Document sent to Telegram");
}
