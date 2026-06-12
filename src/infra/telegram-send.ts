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

/** Telegram hard-caps a message at 4096 chars; stay under it with headroom. */
const MAX_TELEGRAM_CHARS = 3800;

/**
 * Split text into Telegram-sized chunks WITHOUT losing any character. Prefers to
 * break at the last newline before the limit so code blocks and lists stay
 * readable; hard-cuts only a single over-long line with no newline. Pure +
 * unit-tested — the old sendStatusText sliced to 4000 and silently dropped the
 * rest of a long claude_code result.
 */
export function chunkText(text: string, maxLen: number = MAX_TELEGRAM_CHARS): string[] {
  if (text.length === 0) return [];
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let rest = text;
  while (rest.length > maxLen) {
    const newlineCut = rest.lastIndexOf("\n", maxLen);
    const cut = newlineCut > 0 ? newlineCut : maxLen;
    chunks.push(rest.slice(0, cut));
    // Drop the boundary newline we split on (it's re-added by join in tests/render).
    rest = cut === newlineCut ? rest.slice(cut + 1) : rest.slice(cut);
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

/**
 * Deliver a long message to the founder, split across as many Telegram messages
 * as needed. Returns true only if EVERY chunk was sent — the caller uses this to
 * decide whether a deterministic direct-delivery succeeded or whether it must
 * fall back to the normal (LLM) reply path. Plain text (no parse_mode) so code
 * blocks and backticks render literally and never break on tag balance.
 */
export async function sendLongText(
  text: string,
  opts: { chatId?: string | number } = {},
): Promise<boolean> {
  const chatId = opts.chatId ?? defaultChatId();
  const chunks = chunkText(text);
  if (chunks.length === 0) return false;
  try {
    for (const chunk of chunks) {
      await api().sendMessage(chatId, chunk);
    }
    return true;
  } catch (err) {
    log.warn({ chatId, err: (err as Error).message }, "sendLongText failed (will fall back to reply path)");
    return false;
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
