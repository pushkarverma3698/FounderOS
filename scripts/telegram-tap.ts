/**
 * Tap an inline button or reply AS the founder, then print what the bot sends or edits.
 * ======================================================================================
 * telegram-probe.ts sends one text and stops at the first answer. Flows such as `/apply` also need their
 * inline buttons pressed (an answer option, Skip) and a reply typed into an open question, and the bot often
 * answers by editing a card instead of sending a new message. This script does those three things through the
 * same MTProto user client (scripts/lib/mtproto.ts), so a live test runs without the founder's thumbs.
 *
 *   node --import tsx/esm --env-file=.env scripts/telegram-tap.ts list [count]
 *   node --import tsx/esm --env-file=.env scripts/telegram-tap.ts tap <messageId> <callbackData> [waitSeconds]
 *   node --import tsx/esm --env-file=.env scripts/telegram-tap.ts say "<text>" [waitSeconds]
 *
 * It never presses Submit (scripts/lib/tap-guard.ts), and it taps only a callback that is on that message.
 * Costs whatever the tapped flow costs; it belongs in the live-verification zone, like telegram-probe.ts.
 */

import { Api, type TelegramClient } from "telegram";
import { connect, probePeer, sleep, POLL_INTERVAL_MS, QUIET_CYCLES } from "./lib/mtproto.js";
import type { ProbePeer } from "./lib/probe-peer.js";
import { findButton, tapRefusal, type TapButton } from "./lib/tap-guard.js";

const DEFAULT_WAIT_S = 180;
const WINDOW = 30;

function buttonsOf(msg: Api.Message): TapButton[] {
  const out: TapButton[] = [];
  if (!(msg.replyMarkup instanceof Api.ReplyInlineMarkup)) return out;
  for (const row of msg.replyMarkup.rows) {
    for (const b of row.buttons) {
      if (b instanceof Api.KeyboardButtonCallback) out.push({ label: b.text, data: b.data.toString("utf-8") });
      else if (b instanceof Api.KeyboardButtonUrl) out.push({ label: b.text, url: b.url });
    }
  }
  return out;
}

function show(msg: Api.Message, tag: string): void {
  const who = msg.out ? "founder" : "bot";
  const media = msg.media ? ` [${msg.media.className.replace(/^MessageMedia/, "").toLowerCase()}]` : "";
  console.log(`\n#${msg.id} ${tag} ${who}${media}`);
  const text = (msg.message ?? "").trim();
  if (text) console.log(text.slice(0, 1500));
  for (const b of buttonsOf(msg)) {
    console.log(b.url ? `   [${b.label}] ↗ ${b.url}` : `   [${b.label}] → ${b.data}`);
  }
}

async function recent(client: TelegramClient, peer: ProbePeer, limit: number): Promise<Api.Message[]> {
  return [...(await client.getMessages(peer, { limit }))].reverse();
}

/** Edit stamps of recent messages, taken BEFORE the tap or reply so an instant card edit is not missed. */
async function editStamps(client: TelegramClient, peer: ProbePeer): Promise<Map<number, number>> {
  const edits = new Map<number, number>();
  for (const m of await recent(client, peer, WINDOW)) edits.set(m.id, m.editDate ?? 0);
  return edits;
}

/** Prints new bot messages and edits to recent ones until the bot has been quiet a while, or the wait ends. */
async function collect(
  client: TelegramClient,
  peer: ProbePeer,
  afterId: number,
  edits: Map<number, number>,
  waitS: number,
): Promise<number> {
  const deadline = Date.now() + waitS * 1000;
  const seen = new Set<number>();
  let events = 0;
  let lastAt = 0;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    for (const m of await recent(client, peer, WINDOW)) {
      if (m.out) continue;
      if (m.id > afterId && !seen.has(m.id)) {
        seen.add(m.id);
        show(m, "new");
      } else if (m.id <= afterId && (m.editDate ?? 0) !== (edits.get(m.id) ?? 0)) {
        edits.set(m.id, m.editDate ?? 0);
        show(m, "edited");
      } else continue;
      events += 1;
      lastAt = Date.now();
    }
    if (events > 0 && Date.now() - lastAt > POLL_INTERVAL_MS * QUIET_CYCLES * 2) break;
  }
  return events;
}

async function tap(client: TelegramClient, peer: ProbePeer, msgId: number, data: string, waitS: number): Promise<number> {
  const [msg] = await client.getMessages(peer, { ids: [msgId] });
  if (!(msg instanceof Api.Message)) throw new Error(`message #${msgId} not found in this chat`);
  const button = findButton(buttonsOf(msg), data);
  if (!button) throw new Error(`message #${msgId} has no button with callback data ${data}`);
  const refusal = tapRefusal(button);
  if (refusal) throw new Error(refusal);
  const [latest] = await client.getMessages(peer, { limit: 1 });
  const edits = await editStamps(client, peer);
  console.log(`→ tap [${button.label}] on #${msgId} (waiting up to ${waitS}s)`);
  try {
    const answer = await client.invoke(
      new Api.messages.GetBotCallbackAnswer({ peer: await client.getInputEntity(peer), msgId, data: Buffer.from(data, "utf-8") }),
    );
    if (answer.message) console.log(`   toast: ${answer.message}`);
  } catch (err) {
    // allow-failopen: a slow handler answers the callback late (BOT_RESPONSE_TIMEOUT); its messages still arrive.
    console.log(`   callback answer not received: ${String(err).slice(0, 120)}`);
  }
  return collect(client, peer, latest?.id ?? msgId, edits, waitS);
}

async function say(client: TelegramClient, peer: ProbePeer, text: string, waitS: number): Promise<number> {
  const edits = await editStamps(client, peer);
  const sent = await client.sendMessage(peer, { message: text });
  console.log(`→ said #${sent.id} (waiting up to ${waitS}s): ${text}`);
  return collect(client, peer, sent.id, edits, waitS);
}

async function main(): Promise<void> {
  const [cmd, a, b, c] = process.argv.slice(2);
  const client = await connect();
  try {
    const peer = await probePeer(client);
    if (cmd === "list") {
      for (const m of await recent(client, peer, Number(a ?? 10))) show(m, "");
      return;
    }
    let events: number;
    if (cmd === "tap" && a && b) events = await tap(client, peer, Number(a), b, Number(c ?? DEFAULT_WAIT_S));
    else if (cmd === "say" && a) events = await say(client, peer, a, Number(b ?? DEFAULT_WAIT_S));
    else throw new Error('usage: telegram-tap.ts list [count] | tap <messageId> <callbackData> [wait] | say "<text>" [wait]');
    if (events === 0) {
      console.error("\nFAILED: the bot sent and edited nothing.");
      process.exitCode = 1;
    }
  } finally {
    await client.disconnect();
  }
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
