/**
 * Fetch last N messages from the FounderOS Telegram chat via Bot API.
 * Usage: npx tsx scripts/fetch-telegram-history.ts [limit]
 * Default limit: 30
 *
 * Prints: sender, date, text (or media type), message_id
 */

// env already loaded via --env-file flag

const TOKEN = process.env["TELEGRAM_BOT_TOKEN"];
const CHAT_ID = process.env["TELEGRAM_CHAT_ID"];
const LIMIT = parseInt(process.argv[2] ?? "30", 10);

if (!TOKEN) throw new Error("TELEGRAM_BOT_TOKEN not set");
if (!CHAT_ID) throw new Error("TELEGRAM_CHAT_ID not set");

interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name: string;
  username?: string;
}

interface TgMessage {
  message_id: number;
  from?: TgUser;
  date: number;
  text?: string;
  caption?: string;
  sticker?: { emoji?: string; file_id: string };
  document?: { file_name?: string };
  photo?: unknown[];
  voice?: unknown;
  video?: unknown;
}

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
}

async function main() {
  // getUpdates with large offset to drain; then fetch recent
  // We use forwardDate trick: fetch last 100 updates and filter to this chat
  const url = `https://api.telegram.org/bot${TOKEN}/getUpdates?limit=100&allowed_updates=["message"]`;
  const res = await fetch(url);
  const data = (await res.json()) as { ok: boolean; result: TgUpdate[] };

  if (!data.ok) {
    console.error("Telegram API error:", data);
    process.exit(1);
  }

  const messages: TgMessage[] = data.result
    .map((u) => u.message ?? u.edited_message)
    .filter((m): m is TgMessage => !!m)
    .filter((m) => String((m as unknown as { chat: { id: number } }).chat?.id) === String(CHAT_ID))
    .slice(-LIMIT);

  console.log(`\n═══ Last ${messages.length} messages in chat ${CHAT_ID} ═══\n`);

  for (const msg of messages) {
    const ts = new Date(msg.date * 1000).toISOString();
    const sender = msg.from?.is_bot
      ? `🤖 ${msg.from.first_name}`
      : `👤 ${msg.from?.first_name ?? "unknown"}`;
    const content =
      msg.text ??
      msg.caption ??
      (msg.sticker ? `[sticker: ${msg.sticker.emoji ?? ""}]` : null) ??
      (msg.document ? `[doc: ${msg.document.file_name ?? "file"}]` : null) ??
      (msg.photo ? "[photo]" : null) ??
      (msg.voice ? "[voice]" : null) ??
      (msg.video ? "[video]" : null) ??
      "[media]";

    console.log(`[${ts}] #${msg.message_id} ${sender}`);
    console.log(`  ${content}`);
    console.log();
  }
}

main().catch(console.error);
