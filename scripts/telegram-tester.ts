/**
 * FounderOS — Telegram Live Tester (manual QA over the REAL gateway)
 * ===================================================================
 * Drives the production bot through actual Telegram (MTProto user session) —
 * the same path the founder uses. This is the rule-#19 "test the REAL way"
 * harness: message → grammy gateway → office → HITL card → reply, end to end.
 * Claude Code (or any teammate) can run it to act as a manual tester.
 *
 * ONE-TIME SETUP (founder):
 *   1. https://my.telegram.org/apps → create app → copy api_id + api_hash
 *   2. Add to .env:  TELEGRAM_TESTER_API_ID=...  TELEGRAM_TESTER_API_HASH=...
 *   3. npx tsx --env-file=.env scripts/telegram-tester.ts login
 *      (enter phone + code; prints TELEGRAM_TESTER_SESSION= line → add to .env)
 *
 * USAGE (after setup):
 *   npx tsx --env-file=.env scripts/telegram-tester.ts send "list my desktop files" [--wait 90]
 *   npx tsx --env-file=.env scripts/telegram-tester.ts approve     # click ✅ on latest HITL card
 *   npx tsx --env-file=.env scripts/telegram-tester.ts reject      # click ❌
 *   npx tsx --env-file=.env scripts/telegram-tester.ts read [n]    # print last n messages (default 10)
 *
 * `send` waits for the bot's replies (polling, default 90s) and prints them,
 * including any inline approval buttons — so a full HITL flow is:
 *   send "..." → (card appears) → approve → (final reply printed).
 *
 * SECURITY: the session string is a full login to the founder's Telegram
 * account. It lives ONLY in .env (gitignored). Never commit or print it in CI.
 */

import { createInterface } from "node:readline/promises";
import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

const API_ID = parseInt(process.env["TELEGRAM_TESTER_API_ID"] ?? "", 10);
const API_HASH = process.env["TELEGRAM_TESTER_API_HASH"] ?? "";
const SESSION = process.env["TELEGRAM_TESTER_SESSION"] ?? "";
const BOT_TOKEN = process.env["TELEGRAM_BOT_TOKEN"] ?? "";

const POLL_INTERVAL_MS = 2_000;
const DEFAULT_WAIT_S = 90;

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

if (!Number.isFinite(API_ID) || !API_HASH) {
  fail("TELEGRAM_TESTER_API_ID / TELEGRAM_TESTER_API_HASH not set. See setup steps in this file's header.");
}

/** Resolve the bot's @username from the Bot API token (no MTProto needed). */
async function botUsername(): Promise<string> {
  if (!BOT_TOKEN) fail("TELEGRAM_BOT_TOKEN not set.");
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`);
  const json = (await res.json()) as { ok: boolean; result?: { username?: string } };
  if (!json.ok || !json.result?.username) fail("getMe failed — check TELEGRAM_BOT_TOKEN.");
  return json.result.username;
}

async function connect(requireSession: boolean): Promise<TelegramClient> {
  if (requireSession && !SESSION) {
    fail("TELEGRAM_TESTER_SESSION not set. Run the `login` command first.");
  }
  const client = new TelegramClient(new StringSession(SESSION), API_ID, API_HASH, {
    connectionRetries: 3,
  });
  if (requireSession) {
    await client.connect();
    if (!(await client.isUserAuthorized())) fail("Session expired/invalid. Re-run `login`.");
  }
  return client;
}

interface PrintableMessage {
  id: number;
  out: boolean;
  text: string;
  buttons: string[];
}

function toPrintable(msg: Api.Message): PrintableMessage {
  const buttons: string[] = [];
  const markup = msg.replyMarkup;
  if (markup instanceof Api.ReplyInlineMarkup) {
    for (const row of markup.rows) {
      for (const b of row.buttons) {
        if (b instanceof Api.KeyboardButtonCallback) {
          buttons.push(`[${b.text} → ${b.data.toString("utf-8")}]`);
        }
      }
    }
  }
  return { id: msg.id, out: msg.out === true, text: msg.message ?? "(media)", buttons };
}

function printMessage(m: PrintableMessage): void {
  const who = m.out ? "👤 tester" : "🤖 bot";
  console.log(`\n#${m.id} ${who}`);
  console.log(m.text.length > 1_500 ? m.text.slice(0, 1_500) + "…" : m.text);
  if (m.buttons.length > 0) console.log(`   buttons: ${m.buttons.join(" ")}`);
}

async function history(client: TelegramClient, peer: string, limit: number): Promise<Api.Message[]> {
  const msgs = await client.getMessages(peer, { limit });
  return [...msgs].reverse(); // oldest → newest
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function cmdLogin(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const client = await connect(false);
  await client.start({
    phoneNumber: () => rl.question("Phone number (intl format, e.g. +31...): "),
    password: () => rl.question("2FA password (empty if none): "),
    phoneCode: () => rl.question("Code received in Telegram: "),
    onError: async (err) => {
      console.error("Login error:", err.message);
      return true;
    },
  });
  rl.close();
  console.log("\n✓ Logged in. Add this to .env (single line):\n");
  console.log(`TELEGRAM_TESTER_SESSION=${client.session.save()}`);
  await client.disconnect();
}

async function cmdRead(limit: number): Promise<void> {
  const peer = `@${await botUsername()}`;
  const client = await connect(true);
  for (const msg of await history(client, peer, limit)) printMessage(toPrintable(msg));
  await client.disconnect();
}

/** Poll for bot replies newer than sentId until quiet or timeout, printing each. */
async function waitForReplies(
  client: TelegramClient,
  peer: string,
  sentId: number,
  waitS: number,
): Promise<void> {
  const deadline = Date.now() + waitS * 1_000;
  const seen = new Set<number>();
  let lastReplyAt = 0;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    for (const msg of await history(client, peer, 15)) {
      if (msg.id <= sentId || msg.out || seen.has(msg.id)) continue;
      seen.add(msg.id);
      lastReplyAt = Date.now();
      printMessage(toPrintable(msg));
    }
    // Stop early once the bot has replied and gone quiet for 3 poll cycles.
    if (seen.size > 0 && Date.now() - lastReplyAt > POLL_INTERVAL_MS * 3) break;
  }
  if (seen.size === 0) console.log(`(no reply within ${waitS}s)`);
}

async function cmdSend(text: string, waitS: number): Promise<void> {
  const peer = `@${await botUsername()}`;
  const client = await connect(true);

  const sent = await client.sendMessage(peer, { message: text });
  console.log(`→ sent #${sent.id}: ${text}`);
  await waitForReplies(client, peer, sent.id, waitS);
  await client.disconnect();
}

/**
 * Send a media file AS THE FOUNDER (photo or voice note) — the only genuine way
 * to drive the bot's media handlers (Bot API sendPhoto posts as the bot and is
 * never re-ingested). kind "photo" sends an inline image; "voice" sends an
 * OGG/Opus voice note (round waveform bubble, exactly like the phone app).
 */
async function cmdSendMedia(
  kind: "photo" | "voice",
  filePath: string,
  caption: string,
  waitS: number,
): Promise<void> {
  const peer = `@${await botUsername()}`;
  const client = await connect(true);

  const sent = await client.sendFile(peer, {
    file: filePath,
    ...(caption ? { caption } : {}),
    ...(kind === "voice" ? { voiceNote: true } : {}),
    forceDocument: false,
  });
  console.log(`→ sent ${kind} #${sent.id}: ${filePath}${caption ? ` (caption: ${caption})` : ""}`);
  await waitForReplies(client, peer, sent.id, waitS);
  await client.disconnect();
}

async function cmdClick(decision: "approve" | "reject"): Promise<void> {
  const peer = `@${await botUsername()}`;
  const client = await connect(true);

  const msgs = await history(client, peer, 15);
  let matchedData: Buffer | undefined;
  const card = [...msgs].reverse().find((m) => {
    if (m.out || !(m.replyMarkup instanceof Api.ReplyInlineMarkup)) return false;
    for (const row of m.replyMarkup.rows) {
      for (const b of row.buttons) {
        if (b instanceof Api.KeyboardButtonCallback && b.data.toString("utf-8").startsWith(`${decision}:`)) {
          matchedData = b.data;
          return true;
        }
      }
    }
    return false;
  });
  if (!card || !matchedData) fail(`No pending HITL card with a "${decision}" button in the last 15 messages.`);

  await card.click({ data: matchedData });
  console.log(`✓ clicked "${decision}" on card #${card.id} — waiting for the bot's follow-up…`);

  // Watch for the post-decision reply (resume runs the actual side effect).
  const deadline = Date.now() + 60_000;
  const baseline = msgs[msgs.length - 1]!.id;
  const seen = new Set<number>();
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    for (const msg of await history(client, peer, 10)) {
      if (msg.id <= baseline || msg.out || seen.has(msg.id)) continue;
      seen.add(msg.id);
      printMessage(toPrintable(msg));
    }
    if (seen.size > 0) break;
  }
  await client.disconnect();
}

// ── Entry ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "login":
      return cmdLogin();
    case "read":
      return cmdRead(parseInt(rest[0] ?? "10", 10));
    case "send": {
      const waitFlag = rest.indexOf("--wait");
      const waitS = waitFlag >= 0 ? parseInt(rest[waitFlag + 1] ?? `${DEFAULT_WAIT_S}`, 10) : DEFAULT_WAIT_S;
      const text = (waitFlag >= 0 ? rest.slice(0, waitFlag) : rest).join(" ").trim();
      if (!text) fail('Usage: send "message" [--wait seconds]');
      return cmdSend(text, waitS);
    }
    case "sendphoto":
    case "sendvoice": {
      const waitFlag = rest.indexOf("--wait");
      const waitS = waitFlag >= 0 ? parseInt(rest[waitFlag + 1] ?? `${DEFAULT_WAIT_S}`, 10) : DEFAULT_WAIT_S;
      const args = waitFlag >= 0 ? rest.slice(0, waitFlag) : rest;
      const [filePath, ...captionParts] = args;
      if (!filePath) fail(`Usage: ${cmd} <file> [caption…] [--wait seconds]`);
      return cmdSendMedia(cmd === "sendphoto" ? "photo" : "voice", filePath, captionParts.join(" ").trim(), waitS);
    }
    case "approve":
    case "reject":
      return cmdClick(cmd);
    default:
      fail("Usage: telegram-tester.ts <login|send|sendphoto|sendvoice|approve|reject|read>");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => fail(err instanceof Error ? err.message : String(err)));
