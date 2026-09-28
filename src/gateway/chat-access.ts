/**
 * FounderOS — who the Telegram bot answers, and where
 * ====================================================
 * Until 2026-09-28 the bot had one rule: answer `TELEGRAM_CHAT_ID`, drop the
 * rest. A group has its own negative chat id, so adding the bot to a group —
 * the founder with his wife, say — produced a bot that read nothing and said
 * nothing: every update, his own included, went to
 * "Ignored update from unauthorized chat".
 *
 * The rule that replaces it keeps the reason the old one existed (a stranger
 * who finds the bot must not be able to run it, or approve its HITL cards) and
 * adds the cases a group needs:
 *
 *   primary         the founder's own chat — unchanged, everything allowed
 *   allowed         a chat the founder listed in TELEGRAM_ALLOWED_CHAT_IDS —
 *                   everyone in it may talk to the bot
 *   owner-in-group  any other group, but the sender is the founder — he added
 *                   the bot there, so his own messages work without config
 *   denied          anyone else — dropped silently, as before
 *
 * Outside the primary chat, two things stay the founder's alone: approving a
 * side effect (HITL cards, repo dispatch buttons) and the system commands in
 * OWNER_ONLY_COMMANDS. An allow-listed guest can ask the bot anything it can
 * read; they cannot make it act.
 *
 * In a group the bot also answers only when ADDRESSED — a command, an
 * @mention, or a reply to one of its messages. Two people talking to each
 * other must not start a paid model turn per line.
 *
 * Pure: no I/O. The grammy wiring lives in telegram.ts.
 */

export interface ChatAccessConfig {
  readonly primaryChatId: string;
  readonly allowedChatIds: ReadonlySet<string>;
  /** Telegram user id of the founder, or null when it cannot be known. */
  readonly ownerUserId: string | null;
}

const CHAT_ID = /^-?\d+$/;

/**
 * The owner defaults to the primary chat id when that is a PRIVATE chat: in a
 * private chat Telegram makes the chat id equal to the user id, so the number
 * already configured names the founder. A negative primary id is a group and
 * names nobody — then only an explicit TELEGRAM_OWNER_USER_ID can.
 */
export function buildChatAccessConfig(input: {
  readonly primaryChatId: string;
  readonly allowedChatIds?: string | undefined;
  readonly ownerUserId?: string | undefined;
}): ChatAccessConfig {
  const primary = input.primaryChatId.trim();
  const allowed = new Set(
    (input.allowedChatIds ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => CHAT_ID.test(s) && s !== primary),
  );
  const explicitOwner = input.ownerUserId?.trim();
  const ownerUserId =
    explicitOwner && /^\d+$/.test(explicitOwner) ? explicitOwner : /^\d+$/.test(primary) ? primary : null;
  return { primaryChatId: primary, allowedChatIds: allowed, ownerUserId };
}

export type ChatAccess = "primary" | "allowed" | "owner-in-group" | "denied";

export function classifyChatAccess(
  who: { readonly chatId?: number | string; readonly chatType?: string; readonly fromId?: number | string },
  cfg: ChatAccessConfig,
): ChatAccess {
  if (who.chatId === undefined) return "denied";
  const chatId = String(who.chatId);
  if (chatId === cfg.primaryChatId) return "primary";
  if (cfg.allowedChatIds.has(chatId)) return "allowed";
  const isGroup = who.chatType === "group" || who.chatType === "supergroup";
  if (isGroup && cfg.ownerUserId !== null && who.fromId !== undefined && String(who.fromId) === cfg.ownerUserId) {
    return "owner-in-group";
  }
  return "denied";
}

/** May this sender approve a side effect or run a system command here? */
export function mayActAsOwner(access: ChatAccess, fromId: number | string | undefined, cfg: ChatAccessConfig): boolean {
  if (access === "primary") return true;
  if (access === "denied") return false;
  return cfg.ownerUserId !== null && fromId !== undefined && String(fromId) === cfg.ownerUserId;
}

/**
 * Commands a guest in an allow-listed chat may not run. Each one acts on the
 * whole system rather than on the conversation: stop or restart every lane,
 * dispatch engineering work, create a repository, connect an account.
 */
export const OWNER_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  "halt",
  "resume",
  "task",
  "newproject",
  "connect",
]);

/** `/halt@this_bot now` → "halt"; a command for another bot, or no command, → null. */
export function commandName(text: string, botUsername: string): string | null {
  const match = /^\/([a-z0-9_]+)(?:@([a-z0-9_]+))?(?:\s|$)/i.exec(text);
  if (!match) return null;
  const target = match[2];
  if (target !== undefined && target.toLowerCase() !== botUsername.toLowerCase()) return null;
  return match[1]!.toLowerCase();
}

export interface MessageEntityLike {
  readonly type: string;
  readonly offset: number;
  readonly length: number;
  readonly user?: { readonly id: number };
}

export interface InboundMessage {
  readonly chatType: string;
  readonly text?: string | undefined;
  readonly entities?: readonly MessageEntityLike[] | undefined;
  readonly caption?: string | undefined;
  readonly captionEntities?: readonly MessageEntityLike[] | undefined;
  readonly replyToFromId?: number | undefined;
}

function mentionsBot(
  body: string | undefined,
  entities: readonly MessageEntityLike[] | undefined,
  bot: { readonly id: number; readonly username: string },
): boolean {
  if (!body || !entities) return false;
  const handle = `@${bot.username}`.toLowerCase();
  return entities.some((e) =>
    e.type === "mention"
      ? body.slice(e.offset, e.offset + e.length).toLowerCase() === handle
      : e.type === "text_mention" && e.user?.id === bot.id,
  );
}

export function isAddressedToBot(msg: InboundMessage, bot: { readonly id: number; readonly username: string }): boolean {
  if (msg.chatType === "private") return true;
  if (msg.replyToFromId === bot.id) return true;
  const text = msg.text ?? "";
  if (text.startsWith("/")) return commandName(text, bot.username) !== null;
  return mentionsBot(msg.text, msg.entities, bot) || mentionsBot(msg.caption, msg.captionEntities, bot);
}

/** "@founderos_bot show jobs" → "show jobs". Leaves a longer handle that merely starts the same alone. */
export function stripBotMention(text: string, botUsername: string): string {
  const escaped = botUsername.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text
    .replace(new RegExp(`@${escaped}(?![a-z0-9_])`, "gi"), " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** What the founder is told the first time he talks to the bot in a group nobody allow-listed. */
export function openGroupHint(chatId: number | string): string {
  return (
    "I'm answering you here. Everyone else in this chat is ignored until you allow it: " +
    `add <code>TELEGRAM_ALLOWED_CHAT_IDS=${chatId}</code> to the server's env and restart. ` +
    "Mention me or reply to my messages — I stay out of the rest of the conversation."
  );
}
