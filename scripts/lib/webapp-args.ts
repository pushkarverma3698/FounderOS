/**
 * Pure helpers for scripts/telegram-webapp.ts: argument parsing and web_app button lookup.
 * No network, so tests/unit/scripts/telegram-webapp.test.ts covers them.
 */
import type { TapButton } from "./tap-guard.js";

export type WebAppCommand =
  | { readonly cmd: "open"; readonly msgId: number }
  | { readonly cmd: "menu" }
  | { readonly cmd: "latest" };

export const WEBAPP_USAGE = "usage: telegram-webapp.ts open <messageId> | menu | latest";

export function parseWebAppArgs(argv: readonly string[]): WebAppCommand {
  const [cmd, a] = argv;
  if (cmd === "menu" || cmd === "latest") return { cmd };
  if (cmd === "open" && a !== undefined && /^\d+$/.test(a)) return { cmd, msgId: Number(a) };
  throw new Error(WEBAPP_USAGE);
}

/** The first web_app (Mini App) button, if any. */
export function findWebAppButton(buttons: readonly TapButton[]): TapButton | undefined {
  return buttons.find((b) => b.webApp === true && typeof b.url === "string" && b.url.length > 0);
}

export interface MessageButtons {
  readonly id: number;
  readonly out: boolean;
  readonly buttons: readonly TapButton[];
}

/** The newest bot-sent message (not the founder's own) that carries a web_app button. */
export function newestWebAppMessage<T extends MessageButtons>(messages: readonly T[]): T | undefined {
  return messages
    .filter((m) => !m.out && findWebAppButton(m.buttons) !== undefined)
    .sort((x, y) => y.id - x.id)[0];
}

/**
 * The `peer` for messages.requestWebView. The bot's menu button lives only in the private chat with the bot, so
 * that call names the bot as the peer; a probe chat that is a group made Telegram answer USER_BOT_REQUIRED.
 * An inline web_app button opens in the chat that holds its message.
 */
export function webViewPeer<T>(fromBotMenu: boolean, chatPeer: T, botPeer: T): T {
  return fromBotMenu ? botPeer : chatPeer;
}
