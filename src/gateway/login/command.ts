/**
 * FounderOS — /login
 * ==================
 * `/login`                  status of every credential, and how to renew one
 * `/login <tool> [target]`  start a renewal; the next message he sends is the pasted code
 * `/login <tool> add <name>` / `remove <name>`  for tools with several accounts (Google)
 *
 * Founder's private chat only (not a group, not an allow-listed guest): a pasted code or token
 * is a credential, and a group member must neither start a login nor have a message swallowed.
 */

import type { Context } from "grammy";
import { classifyChatAccess, type ChatAccessConfig } from "../chat-access.js";
import { splitForTelegram } from "../format.js";
import { childLogger } from "../../infra/logger.js";
import { PendingLogins } from "./pending.js";
import { LOGIN_ADAPTERS } from "./registry.js";
import type { LoginAdapter, LoginTargetStatus } from "./types.js";

const log = childLogger({ module: "gateway:login" });

export interface LoginDeps {
  readonly adapters: readonly LoginAdapter[];
  readonly pending: PendingLogins;
  readonly access: ChatAccessConfig;
}

export function defaultLoginDeps(access: ChatAccessConfig): LoginDeps {
  return { adapters: LOGIN_ADAPTERS, pending: new PendingLogins(), access };
}

const esc = (s: string): string => s.replace(/[<>&]/g, (c) => (c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;"));

function isFounderDm(ctx: Context, deps: LoginDeps): boolean {
  return (
    ctx.chat?.type === "private" &&
    classifyChatAccess({ chatId: ctx.chat.id, chatType: ctx.chat.type, fromId: ctx.from?.id }, deps.access) === "primary"
  );
}

async function send(ctx: Context, html: string): Promise<void> {
  for (const part of splitForTelegram(html)) {
    await ctx.reply(part, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  }
}

async function statusScreen(deps: LoginDeps): Promise<string> {
  const blocks = await Promise.all(
    deps.adapters.map(async (a) => {
      // allow-failopen: one broken adapter must not blank the whole screen; its row says so.
      const rows = await a.status().catch((err: unknown): readonly LoginTargetStatus[] => [
        { target: "-", label: a.title, ok: false, detail: `status check failed: ${err instanceof Error ? err.message : String(err)}` },
      ]);
      const lines = rows.map((r) => `${!r.ok ? "❌" : r.unverified ? "❔" : "✅"} ${esc(r.label)} — ${esc(r.detail)}`);
      return `<b>${esc(a.title)}</b>\n${lines.join("\n") || "no targets configured"}`;
    }),
  );
  const usage = deps.adapters
    .map((a) => {
      const renew = `/login ${a.id}${a.targets.length > 1 ? ` ${a.targets.join("|")}` : ""}`;
      return a.addProblem ? `${renew}\n/login ${a.id} add &lt;name&gt; · /login ${a.id} remove &lt;name&gt;` : renew;
    })
    .join("\n");
  return `${blocks.join("\n\n")}\n\nRenew one:\n${usage}`;
}

export async function handleLogin(ctx: Context, deps: LoginDeps): Promise<void> {
  if (!isFounderDm(ctx, deps)) {
    await ctx.reply("/login works only in your private chat with the bot.");
    return;
  }
  const chatId = String(ctx.chat!.id);
  const [toolArg, targetArg, nameArg] = (typeof ctx.match === "string" ? ctx.match : "").trim().toLowerCase().split(/\s+/);
  if (!toolArg) {
    await send(ctx, await statusScreen(deps));
    return;
  }
  if (toolArg === "cancel") {
    const waiting = await deps.pending.peek(chatId);
    await deps.pending.drop(chatId);
    await send(ctx, waiting ? `Cancelled the ${esc(waiting.adapter.title)} login. Nothing was changed.` : "No login is waiting.");
    return;
  }
  const adapter = deps.adapters.find((a) => a.id === toolArg);
  if (!adapter) {
    await send(ctx, `No login for "${esc(toolArg)}". Valid: ${deps.adapters.map((a) => a.id).join(", ")}`);
    return;
  }
  if (targetArg === "remove" && adapter.remove) {
    await removeTarget(ctx, adapter, nameArg ?? "");
    return;
  }
  const adding = targetArg === "add" && adapter.addProblem !== undefined;
  const target = adding ? (nameArg ?? "") : targetArg || (adapter.targets.length === 1 ? adapter.targets[0]! : "");
  if (adding && !adapter.targets.includes(target)) {
    const problem = target ? adapter.addProblem!(target) : `Name it: /login ${adapter.id} add &lt;name&gt; (e.g. wife, oplify).`;
    if (problem) {
      await send(ctx, problem);
      return;
    }
  } else if (!adapter.targets.includes(target)) {
    const add = adapter.addProblem ? `\nNew account: /login ${adapter.id} add &lt;name&gt;` : "";
    await send(ctx, `Which one? /login ${adapter.id} ${adapter.targets.join(" | ")}${add}`);
    return;
  }
  try {
    const started = await adapter.start(target);
    await deps.pending.begin(chatId, adapter, target, started);
    await send(ctx, `${started.html}\n\nChanged your mind? /login cancel`);
  } catch (err) {
    log.error({ tool: adapter.id, target, err: err instanceof Error ? err.message : String(err) }, "login start failed");
    await send(ctx, `Could not start the ${esc(adapter.title)} login: ${esc(err instanceof Error ? err.message : String(err))}`);
  }
}

async function removeTarget(ctx: Context, adapter: LoginAdapter, name: string): Promise<void> {
  if (!adapter.targets.includes(name)) {
    await send(ctx, `Which one? /login ${adapter.id} remove ${adapter.targets.join(" | ")}`);
    return;
  }
  try {
    await send(ctx, (await adapter.remove!(name)).html);
  } catch (err) {
    log.error({ tool: adapter.id, target: name, err: err instanceof Error ? err.message : String(err) }, "login remove failed");
    await send(ctx, `Could not remove ${esc(name)}: ${esc(err instanceof Error ? err.message : String(err))}`);
  }
}

/**
 * Codes, callback URLs and tokens are one run of characters with at least one digit. Anything else
 * ("what's on today", "yesterday") is a normal message and goes to the kernel; the attempt stays open.
 */
const looksLikePaste = (text: string): boolean => !/\s/.test(text) && /\d/.test(text);

/**
 * Called before the kernel sees a text message. Returns true when the message was the pasted
 * reply to a pending login (consumed: never reaches the kernel, never logged, deleted from the chat).
 */
export async function handleLoginReply(ctx: Context, deps: LoginDeps): Promise<boolean> {
  if (!isFounderDm(ctx, deps)) return false;
  const chatId = String(ctx.chat!.id);
  const pending = await deps.pending.peek(chatId);
  const text = ctx.message?.text?.trim() ?? "";
  if (!pending || !text || text.startsWith("/") || !looksLikePaste(text)) return false;

  // allow-failopen: the paste is a credential; if Telegram refuses the delete, finishing the login still matters more.
  await ctx.deleteMessage().catch(() => undefined);
  let result;
  try {
    result = await pending.adapter.finish(pending.target, text, pending.started.state);
  } catch (err) {
    log.error({ tool: pending.adapter.id, target: pending.target, err: err instanceof Error ? err.message : String(err) }, "login finish failed");
    result = { ok: false, html: `The ${esc(pending.adapter.title)} login failed: ${esc(err instanceof Error ? err.message : String(err))}` };
  }
  // A failed paste keeps the attempt open (a typo should not cost a new link); success closes it.
  if (result.ok) await deps.pending.drop(chatId);
  await send(ctx, result.html);
  return true;
}
