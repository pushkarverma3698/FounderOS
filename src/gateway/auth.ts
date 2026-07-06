/**
 * FounderOS — Telegram Sender Authorization (C1 fix)
 * ====================================================
 * Before this module existed, `registerHandlers` attached message/media/callback
 * handlers with no check of WHO sent the update — any Telegram user who found the
 * bot could drive the full office (read the founder's Gmail, laptop files, etc.)
 * and tap Approve on their own HITL cards, since the card is posted back to the
 * sender's own chat. `TELEGRAM_CHAT_ID` was only ever used for OUTBOUND pushes
 * (see infra/telegram-send.ts), never to gate inbound updates.
 *
 * Fail-safe default: the founder's own chat (TELEGRAM_CHAT_ID, already required
 * at boot) is always authorized, so existing single-founder deployments are
 * protected with zero new required config. Set FOUNDER_TELEGRAM_IDS to a
 * comma-separated list to authorize additional principals (a second device, a
 * co-founder) without widening the default.
 */

import { env } from "../core/config.js";

/** The set of Telegram user/chat ids allowed to drive the office. */
export function founderTelegramIds(): Set<string> {
  const raw = (process.env["FOUNDER_TELEGRAM_IDS"] ?? "").trim() || env.TELEGRAM_CHAT_ID;
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/** Minimal shape we need from a grammy Context — kept structural for easy testing. */
export interface AuthCheckable {
  from?: { id?: number } | undefined;
  chat?: { id?: number } | undefined;
}

/**
 * True when the update's sender OR chat is on the authorized list. Checking
 * both covers the common single-founder private-chat case (from.id === chat.id)
 * as well as a group chat where the chat itself is authorized regardless of the
 * particular member who posted.
 */
export function isAuthorizedTelegramUser(ctx: AuthCheckable): boolean {
  const ids = founderTelegramIds();
  if (ids.size === 0) return false; // fail closed — never silently open
  const fromId = ctx.from?.id !== undefined ? String(ctx.from.id) : undefined;
  const chatId = ctx.chat?.id !== undefined ? String(ctx.chat.id) : undefined;
  return (fromId !== undefined && ids.has(fromId)) || (chatId !== undefined && ids.has(chatId));
}
