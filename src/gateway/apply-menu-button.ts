/**
 * The jobs bot's chat menu button: opens the Mini App job list (/apply/home) from the founder's private chat.
 * Set once at startup. Only when the public apply base URL is configured and https (Telegram refuses a web_app
 * button otherwise) and TELEGRAM_CHAT_ID is a positive id, i.e. his private chat, never a group.
 */

import { logger } from "../infra/logger.js";
import { opensInTelegram } from "./apply-flow.js";
import { applyHomeUrl } from "./apply-home.js";

const log = logger.child({ module: "apply-menu-button" });

export interface MenuButtonApi {
  setChatMenuButton(other: {
    chat_id: number;
    menu_button: { type: "web_app"; text: string; web_app: { url: string } };
  }): Promise<unknown>;
}

export async function publishApplyMenuButton(
  api: MenuButtonApi,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<"set" | "skipped"> {
  const url = applyHomeUrl(env);
  const chatId = env["TELEGRAM_CHAT_ID"]?.trim() ?? "";
  if (!url || !opensInTelegram(chatId, url)) return "skipped";
  try {
    await api.setChatMenuButton({ chat_id: Number(chatId), menu_button: { type: "web_app", text: "Jobs", web_app: { url } } });
    log.info("Jobs bot menu button set to the Mini App job list");
    return "set";
  } catch (err) {
    // allow-failopen: the menu button is a shortcut; /apply opens the same page, so a refusal is a warning.
    log.warn({ err: (err as Error).message }, "Could not set the menu button, /apply still works");
    return "skipped";
  }
}
