import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
const client = new TelegramClient(new StringSession(process.env["TELEGRAM_TESTER_SESSION"]!), parseInt(process.env["TELEGRAM_TESTER_API_ID"]!, 10), process.env["TELEGRAM_TESTER_API_HASH"]!, { connectionRetries: 3 });
await client.connect();
const res = await fetch(`https://api.telegram.org/bot${process.env["TELEGRAM_BOT_TOKEN"]}/getMe`);
const me = (await res.json()) as { result: { username: string } };
const msgs = await client.getMessages(`@${me.result.username}`, { limit: 5 });
const voiceMsg = msgs.find((m) => m.media && !m.out);
if (!voiceMsg) { console.log("no media msg found"); process.exit(1); }
const buf = await client.downloadMedia(voiceMsg);
const { writeFileSync } = await import("node:fs");
writeFileSync("/tmp/reply_voice.ogg", buf as Buffer);
console.log("downloaded msg", voiceMsg.id, "bytes:", (buf as Buffer).length);
await client.disconnect();
process.exit(0);
