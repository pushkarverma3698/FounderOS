/**
 * Get a REAL signed Mini App URL (with #tgWebAppData=...) as the founder, so the job "answer page" can be
 * driven in a browser without a phone. Telegram signs initData only for a genuine launch, so this asks
 * Telegram for one through the same MTProto user client as telegram-probe.ts / telegram-tap.ts.
 *
 *   node --import tsx/esm --env-file=.env scripts/telegram-webapp.ts open <messageId>   # web_app button on that bot message
 *   node --import tsx/esm --env-file=.env scripts/telegram-webapp.ts latest             # newest bot message with a web_app button
 *   node --import tsx/esm --env-file=.env scripts/telegram-webapp.ts menu               # the bot's menu button
 *
 * Only the URL goes to stdout (pipe-friendly); diagnostics go to stderr. The URL carries the founder's signed
 * initData, so treat it like a credential: do not paste it into chats, PRs or logs.
 * API: Api.messages.RequestWebView -> Api.WebViewResultUrl; Api.bots.GetBotMenuButton -> Api.BotMenuButton.
 * Related scripts: telegram-probe.ts (send a prompt, print replies), telegram-tap.ts (list / tap / say).
 */

import { Api, type TelegramClient } from "telegram";
import { botUsername, connect, probePeer } from "./lib/mtproto.js";
import type { ProbePeer } from "./lib/probe-peer.js";
import type { TapButton } from "./lib/tap-guard.js";
import { findWebAppButton, newestWebAppMessage, parseWebAppArgs, webViewPeer } from "./lib/webapp-args.js";

const WINDOW = 50;
const PLATFORM = "android";

function buttonsOf(msg: Api.Message): TapButton[] {
  const out: TapButton[] = [];
  if (!(msg.replyMarkup instanceof Api.ReplyInlineMarkup)) return out;
  for (const row of msg.replyMarkup.rows) {
    for (const b of row.buttons) {
      if (b instanceof Api.KeyboardButtonWebView) out.push({ label: b.text, url: b.url, webApp: true });
    }
  }
  return out;
}

async function requestUrl(client: TelegramClient, peer: ProbePeer, url: string, fromBotMenu: boolean): Promise<string> {
  const bot = await client.getInputEntity(await botUsername());
  const result = await client.invoke(
    new Api.messages.RequestWebView({
      peer: webViewPeer(fromBotMenu, await client.getInputEntity(peer), bot),
      bot,
      url,
      platform: PLATFORM,
      fromBotMenu,
    }),
  );
  if (!(result instanceof Api.WebViewResultUrl) || !result.url) throw new Error("Telegram returned no web view URL.");
  return result.url;
}

async function open(client: TelegramClient, peer: ProbePeer, msgId: number): Promise<string> {
  const [msg] = await client.getMessages(peer, { ids: [msgId] });
  if (!(msg instanceof Api.Message)) throw new Error(`message #${msgId} not found in this chat`);
  const button = findWebAppButton(buttonsOf(msg));
  if (!button?.url) throw new Error(`message #${msgId} has no web_app button`);
  console.error(`opening [${button.label}] on #${msgId}`);
  return requestUrl(client, peer, button.url, false);
}

async function latest(client: TelegramClient, peer: ProbePeer): Promise<string> {
  const msgs = (await client.getMessages(peer, { limit: WINDOW })).map((m) => ({
    id: m.id,
    out: Boolean(m.out),
    buttons: m instanceof Api.Message ? buttonsOf(m) : [],
  }));
  const found = newestWebAppMessage(msgs);
  if (!found) throw new Error(`none of the last ${WINDOW} messages is a bot message with a web_app button`);
  return open(client, peer, found.id);
}

async function menu(client: TelegramClient, peer: ProbePeer): Promise<string> {
  const bot = await client.getInputEntity(await botUsername());
  const button = await client.invoke(new Api.bots.GetBotMenuButton({ userId: bot }));
  if (!(button instanceof Api.BotMenuButton) || !button.url) {
    throw new Error("this bot has no web_app menu button configured (BotMenuButtonDefault or Commands only).");
  }
  console.error(`opening menu button [${button.text}]`);
  return requestUrl(client, peer, button.url, true);
}

async function main(): Promise<void> {
  const args = parseWebAppArgs(process.argv.slice(2));
  const client = await connect();
  try {
    const peer = await probePeer(client);
    const url =
      args.cmd === "open" ? await open(client, peer, args.msgId) : args.cmd === "latest" ? await latest(client, peer) : await menu(client, peer);
    console.log(url);
  } finally {
    await client.disconnect();
  }
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
