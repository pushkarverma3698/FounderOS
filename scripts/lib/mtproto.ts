/**
 * MTProto plumbing — drive the LIVE bot as the founder.
 * ======================================================
 * The Telegram Bot API cannot do this: `sendMessage` posts AS the bot, which the
 * bot never re-ingests, and `answerCallbackQuery` is a bot→Telegram ack rather
 * than a button press. Only an MTProto *user* client can send as the founder and
 * tap Approve/Reject. So any harness built on curl tests nothing.
 *
 * ── ONE-TIME SETUP (founder) ─────────────────────────────────────────────────
 *   1. https://my.telegram.org/apps → create app → copy api_id + api_hash
 *   2. .env:  TELEGRAM_TESTER_API_ID=...  TELEGRAM_TESTER_API_HASH=...
 *   3. npx tsx --env-file=.env scripts/telegram-tester.ts login
 *      → paste the printed TELEGRAM_TESTER_SESSION=... line into .env
 *
 * SECURITY: TELEGRAM_TESTER_SESSION is a full login to the founder's Telegram
 * account. It lives only in .env (gitignored). Never commit, print, or ship it.
 *
 * NOTE ON DUPLICATION: scripts/e2e-telegram-qa.ts carries an older private copy
 * of these same helpers. It is 790 lines of production-acceptance tooling with
 * no test coverage, so this module deliberately does NOT refactor it — the risk
 * of breaking the acceptance suite outweighs deduplication today. Migrate it
 * here when someone next has cause to touch that file.
 */

import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

const API_ID = parseInt(process.env["TELEGRAM_TESTER_API_ID"] ?? "", 10);
const API_HASH = process.env["TELEGRAM_TESTER_API_HASH"] ?? "";
const SESSION = process.env["TELEGRAM_TESTER_SESSION"] ?? "";
const BOT_TOKEN = process.env["TELEGRAM_BOT_TOKEN"] ?? "";

/** How often to re-read history while waiting for the bot. */
export const POLL_INTERVAL_MS = 2_000;
/** Stop collecting once the bot has been quiet for this many polls. */
export const QUIET_CYCLES = 3;

export interface BotReply {
  readonly id: number;
  readonly text: string;
  /** callback_data values on an inline card, e.g. ["approve","reject"]. */
  readonly buttons: string[];
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Throw with a legible message rather than a stack trace into the founder's terminal. */
export function assertMtprotoConfigured(): void {
  if (!Number.isFinite(API_ID) || !API_HASH || !SESSION) {
    throw new Error(
      "MTProto session not configured. Need TELEGRAM_TESTER_API_ID / _API_HASH / _SESSION in .env.\n" +
        "  Run: npx tsx --env-file=.env scripts/telegram-tester.ts login",
    );
  }
}

/** Resolve the bot's @username from its token — the peer every message is sent to. */
export async function botUsername(): Promise<string> {
  if (!BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN not set.");
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`);
  const json = (await res.json()) as { ok: boolean; result?: { username?: string } };
  if (!json.ok || !json.result?.username) throw new Error("getMe failed — check TELEGRAM_BOT_TOKEN.");
  return json.result.username;
}

export async function connect(): Promise<TelegramClient> {
  assertMtprotoConfigured();
  const client = new TelegramClient(new StringSession(SESSION), API_ID, API_HASH, {
    connectionRetries: 3,
  });
  // Quiet gramjs' own INFO logging so the evidence stream stays readable.
  // @ts-expect-error gramjs logger level setter
  client.setLogLevel?.("error");
  await client.connect();
  if (!(await client.isUserAuthorized())) {
    throw new Error("Session expired/invalid. Re-run: npx tsx --env-file=.env scripts/telegram-tester.ts login");
  }
  return client;
}

function toReply(msg: Api.Message): BotReply {
  const buttons: string[] = [];
  if (msg.replyMarkup instanceof Api.ReplyInlineMarkup) {
    for (const row of msg.replyMarkup.rows) {
      for (const b of row.buttons) {
        if (b instanceof Api.KeyboardButtonCallback) buttons.push(b.data.toString("utf-8"));
      }
    }
  }
  return { id: msg.id, text: msg.message ?? "(media)", buttons };
}

async function history(client: TelegramClient, peer: string, limit: number): Promise<Api.Message[]> {
  const msgs = await client.getMessages(peer, { limit });
  return [...msgs].reverse(); // oldest → newest
}

export interface SendResult {
  /** ISO-8601 UTC instant the prompt was actually delivered — the benchmark's `sent at`. */
  readonly sentAt: string;
  readonly replies: BotReply[];
  /** Set when Telegram refused the send itself; `replies` is empty and this says why. */
  readonly sendError?: string;
}

/**
 * Send one message as the founder and collect every NEW bot reply until the bot
 * goes quiet (or `waitS` elapses).
 *
 * A send Telegram rejects at the transport level (e.g. MESSAGE_EMPTY on a blank
 * prompt) is returned as `sendError`, never thrown: one bad task must not abort
 * a 34-task run the founder is sitting through.
 */
export async function sendAndCollect(
  client: TelegramClient,
  peer: string,
  text: string,
  waitS: number,
): Promise<SendResult> {
  let sent;
  const sentAt = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  try {
    sent = await client.sendMessage(peer, { message: text });
  } catch (err) {
    return { sentAt, replies: [], sendError: String(err).slice(0, 200) };
  }

  const deadline = Date.now() + waitS * 1_000;
  const seen = new Set<number>();
  const replies: BotReply[] = [];
  let lastAt = 0;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    for (const msg of await history(client, peer, 20)) {
      if (msg.id <= sent.id || msg.out || seen.has(msg.id)) continue;
      seen.add(msg.id);
      lastAt = Date.now();
      replies.push(toReply(msg));
    }
    if (replies.length > 0 && Date.now() - lastAt > POLL_INTERVAL_MS * QUIET_CYCLES) break;
  }

  return { sentAt, replies };
}
