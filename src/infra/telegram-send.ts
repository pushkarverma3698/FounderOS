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
 * The Telegram chat a kernel thread belongs to. Thread ids are `<tenant>:<chatId>`
 * (src/gateway/kernel-run.ts threadIdFor); anything else yields undefined, and
 * the caller falls back to defaultChatId(). Lets a tool answer the chat that
 * asked — a family group — instead of always the founder's DM.
 */
export function chatIdFromThreadId(threadId: unknown): string | undefined {
  if (typeof threadId !== "string") return undefined;
  const tail = threadId.slice(threadId.lastIndexOf(":") + 1);
  return /^-?\d+$/.test(tail) ? tail : undefined;
}

/**
 * Send a short plain-text status message to a Telegram chat.
 * Used by long-running tools (claude_code) to stream progress to the founder
 * while the office run is still in flight. Best-effort: failures are logged,
 * never thrown — a progress ping must not kill the task it reports on.
 */
export async function sendStatusText(
  text: string,
  opts: { chatId?: string | number } = {},
): Promise<void> {
  const chatId = opts.chatId ?? defaultChatId();
  try {
    await api().sendMessage(chatId, text.slice(0, 4000));
  } catch (err) {
    log.warn({ chatId, err: (err as Error).message }, "Status text send failed (non-fatal)");
  }
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
): Promise<void> {
  const target = jobsChatId();
  try {
    await api().sendMessage(target, text, { parse_mode: parseMode });
  } catch (err) {
    if (target === defaultChatId() || !isChatUnreachable(err)) throw err;
    log.error(
      { target, err: err instanceof Error ? err.message : String(err) },
      "Jobs chat unreachable — sending this job message to the founder's chat",
    );
    // Two sends, the notice as plain text: the reason comes from Telegram and must not be able to break
    // an HTML parse, and the job message keeps its own formatting.
    await api().sendMessage(defaultChatId(), unreachableNotice(err));
    await api().sendMessage(defaultChatId(), text, { parse_mode: parseMode });
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
