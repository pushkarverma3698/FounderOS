/**
 * The "Edit answers" button on /profile
 * =====================================
 * A web_app button opens the saved-answers editor inside Telegram. It is offered only in a private chat (a
 * positive chat id: Telegram refuses web_app buttons in groups) on an https URL, and only to the person whose
 * profile is being shown, because the editor signs in as the Telegram user and edits that user's own profile.
 * In a group, or for someone looking at another candidate's profile, /profile keeps its text and commands.
 */

import { InlineKeyboard } from "grammy";
import { readApplyLinkConfig } from "../tools/jobhunt/apply-link.js";
import { opensInTelegram } from "./apply-flow.js";
import { profileForUser } from "./miniapp-auth.js";

type Env = Readonly<Record<string, string | undefined>>;

/** The editor's URL, or null when the link base is not configured. */
export function profileEditorUrl(env: Env): string | null {
  const cfg = readApplyLinkConfig(env);
  return cfg.ok ? `${cfg.baseUrl}/apply/profile` : null;
}

export function profileEditorKeyboard(
  chatId: number | string | undefined,
  userId: number | undefined,
  shownProfileId: string,
  env: Env = process.env,
): InlineKeyboard | null {
  if (chatId === undefined || userId === undefined) return null;
  const url = profileEditorUrl(env);
  if (!url || !opensInTelegram(String(chatId), url)) return null;
  if (profileForUser(userId, env) !== shownProfileId) return null;
  return new InlineKeyboard().webApp("Edit answers", url);
}
