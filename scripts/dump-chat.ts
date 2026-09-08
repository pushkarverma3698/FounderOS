/**
 * Dump Telegram chat history for auditing links and bot bugs.
 * Usage: node --env-file=.env --import tsx/esm scripts/dump-chat.ts [target_count] [output_file]
 */

import { writeFileSync } from "node:fs";
import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

const API_ID = parseInt(process.env["TELEGRAM_TESTER_API_ID"] ?? "", 10);
const API_HASH = process.env["TELEGRAM_TESTER_API_HASH"] ?? "";
const SESSION = process.env["TELEGRAM_TESTER_SESSION"] ?? "";
const BOT_TOKEN = process.env["TELEGRAM_BOT_TOKEN"] ?? "";

const TARGET_COUNT = parseInt(process.argv[2] ?? "3000", 10);
const OUTPUT_FILE = process.argv[3] ?? "/tmp/telegram_chat_dump.json";

async function main() {
  if (!API_ID || !API_HASH || !SESSION) {
    throw new Error("TELEGRAM_TESTER credentials missing from env");
  }

  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`);
  const botInfo = (await res.json()) as { ok: boolean; result?: { username?: string } };
  if (!botInfo.ok || !botInfo.result?.username) {
    throw new Error("Failed to get bot username from TELEGRAM_BOT_TOKEN");
  }
  const username = botInfo.result.username;

  const client = new TelegramClient(new StringSession(SESSION), API_ID, API_HASH, {
    connectionRetries: 3,
  });
  await client.connect();

  const peer = `@${username}`;
  console.log(`Connected. Reading chat with peer: ${peer}, target count: ${TARGET_COUNT}`);

  const allMessages: Array<{
    id: number;
    date: string;
    out: boolean;
    text: string;
    urls: Array<{ type: string; url: string; label?: string }>;
    hasMedia: boolean;
    mediaType: string | null;
    buttons: string[];
  }> = [];

  let offsetId = 0;

  while (allMessages.length < TARGET_COUNT) {
    const batchSize = Math.min(100, TARGET_COUNT - allMessages.length);
    const msgs = await client.getMessages(peer, {
      limit: batchSize,
      offsetId: offsetId,
    });

    if (!msgs || msgs.length === 0) break;

    for (const msg of msgs) {
      if (msg instanceof Api.Message) {
        const urls: Array<{ type: string; url: string; label?: string }> = [];

        // 1. Check entities (formatted links)
        if (msg.entities) {
          for (const ent of msg.entities) {
            if (ent instanceof Api.MessageEntityTextUrl) {
              const label = msg.message?.slice(ent.offset, ent.offset + ent.length);
              urls.push({ type: "text_url", url: ent.url, label });
            } else if (ent instanceof Api.MessageEntityUrl) {
              const urlText = msg.message?.slice(ent.offset, ent.offset + ent.length);
              if (urlText) urls.push({ type: "url_entity", url: urlText });
            }
          }
        }

        // 2. Inline keyboard buttons
        const buttons: string[] = [];
        if (msg.replyMarkup instanceof Api.ReplyInlineMarkup) {
          for (const row of msg.replyMarkup.rows) {
            for (const b of row.buttons) {
              if (b instanceof Api.KeyboardButtonUrl) {
                urls.push({ type: "button_url", url: b.url, label: b.text });
                buttons.push(`[URL:${b.text} -> ${b.url}]`);
              } else if (b instanceof Api.KeyboardButtonCallback) {
                buttons.push(`[CB:${b.text} -> ${b.data.toString("utf-8")}]`);
              }
            }
          }
        }

        // 3. Raw text URL extraction
        const text = msg.message ?? "";
        const urlRegex = /https?:\/\/[^\s\)\"\'\<\>]+/g;
        let match: RegExpExecArray | null;
        while ((match = urlRegex.exec(text)) !== null) {
          let raw = match[0];
          raw = raw.replace(/[.,;:\)]+$/, "");
          if (!urls.some((u) => u.url === raw)) {
            urls.push({ type: "regex_text", url: raw });
          }
        }

        allMessages.push({
          id: msg.id,
          date: new Date(msg.date * 1000).toISOString(),
          out: msg.out === true,
          text: msg.message ?? "",
          urls,
          hasMedia: !!msg.media,
          mediaType: msg.media ? msg.media.className : null,
          buttons,
        });
      }
    }

    const lastMsg = msgs[msgs.length - 1];
    if (lastMsg) offsetId = lastMsg.id;
    console.log(`Fetched ${allMessages.length} messages (last id: ${offsetId})...`);
    if (msgs.length < batchSize) break;
  }

  // Reverse so chronological: oldest to newest
  allMessages.reverse();

  writeFileSync(OUTPUT_FILE, JSON.stringify(allMessages, null, 2));
  console.log(`\nSuccessfully dumped ${allMessages.length} messages to ${OUTPUT_FILE}`);
  await client.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
