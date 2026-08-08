import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

const API_ID = parseInt(process.env["TELEGRAM_TESTER_API_ID"] || "0", 10);
const API_HASH = process.env["TELEGRAM_TESTER_API_HASH"] || "";
const SESSION = process.env["TELEGRAM_TESTER_SESSION"] || "";
const token = process.env["TELEGRAM_BOT_TOKEN"] || "";

async function botUsername(): Promise<string> {
  const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  const json = (await res.json()) as { ok: boolean; result?: { username?: string } };
  if (!json.ok || !json.result?.username) throw new Error("getMe failed");
  return json.result.username;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const client = new TelegramClient(new StringSession(SESSION), API_ID, API_HASH, {
    connectionRetries: 5,
  });
  await client.connect();
  const peer = `@${await botUsername()}`;

  const prompt = "what all jobs has been captured give me a csv";
  console.log(`\n=== SENDING PROMPT: "${prompt}" ===\n`);

  const beforeHistory = await client.getMessages(peer, { limit: 1 });
  const baselineId = beforeHistory[0]?.id ?? 0;

  await client.sendMessage(peer, { message: prompt });

  const deadline = Date.now() + 60_000;
  let approvedCard = false;

  while (Date.now() < deadline) {
    await sleep(3000);
    const msgs = await client.getMessages(peer, { limit: 10 });
    const newMsgs = msgs.filter((m) => m.id > baselineId && !m.out);

    for (const msg of newMsgs.reverse()) {
      console.log(`[BOT Message #${msg.id}]: ${msg.text.slice(0, 150)}...`);

      // Check if this message has an inline keyboard button (HITL card)
      if (
        !approvedCard &&
        msg.replyMarkup instanceof Api.ReplyInlineMarkup &&
        msg.replyMarkup.rows.some((row) =>
          row.buttons.some(
            (b) => b instanceof Api.KeyboardButtonCallback && b.data.toString("utf-8") === "approve"
          )
        )
      ) {
        console.log(`\n👉 FOUND HITL APPROVAL CARD! Clicking 'approve'...\n`);
        await sleep(1000);
        await msg.click({ data: Buffer.from("approve") });
        approvedCard = true;
      }

      if (msg.media) {
        console.log(`\n🎉 RECEIVED MEDIA ATTACHMENT: ${msg.media.className}\n`);
        if (msg.media instanceof Api.MessageMediaDocument) {
          console.log(`    Filename / Document detected! Delivery verified!`);
        }
      }
    }

    // Stop if we received a document attachment or final execution confirmation
    const hasDoc = newMsgs.some((m) => m.media instanceof Api.MessageMediaDocument);
    if (hasDoc) {
      console.log("\n✅ SUCCESS: Document attachment received in Telegram!");
      break;
    }
  }

  await client.disconnect();
}

main().catch(console.error);
