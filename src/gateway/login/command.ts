/**
 * FounderOS — /login
 * ==================
 * `/login`                  status of every credential, and how to renew one
 * `/login <tool> [target]`  start a renewal; the next message he sends is the pasted code
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
import type { LoginAdapter } from "./types.js";

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
      const rows = await a.status().catch((err: unknown) => [
        { target: "-", label: a.title, ok: false, detail: `status check failed: ${err instanceof Error ? err.message : String(err)}` },
      ]);
      const lines = rows.map((r) => `${r.ok ? "✅" : "❌"} ${esc(r.label)} — ${esc(r.detail)}`);
      return `<b>${esc(a.title)}</b>\n${lines.join("\n") || "no targets configured"}`;
    }),
  );
  const usage = deps.adapters
    .map((a) => `/login ${a.id}${a.targets.length > 1 ? ` ${a.targets.join("|")}` : ""}`)
    .join("\n");
  return `${blocks.join("\n\n")}\n\nRenew one:\n${usage}`;
}

export async function handleLogin(ctx: Context, deps: LoginDeps): Promise<void> {
  if (!isFounderDm(ctx, deps)) {
    await ctx.reply("/login works only in your private chat with the bot.");
    return;
  }
  const chatId = String(ctx.chat!.id);
  const [toolArg, targetArg] = (typeof ctx.match === "string" ? ctx.match : "").trim().toLowerCase().split(/\s+/);
  if (!toolArg) {
    await send(ctx, await statusScreen(deps));
    return;
  }
  const adapter = deps.adapters.find((a) => a.id === toolArg);
  if (!adapter) {
    await send(ctx, `No login for "${esc(toolArg)}". Valid: ${deps.adapters.map((a) => a.id).join(", ")}`);
    return;
  }
  const target = targetArg || (adapter.targets.length === 1 ? adapter.targets[0]! : "");
  if (!adapter.targets.includes(target)) {
    await send(ctx, `Which one? /login ${adapter.id} ${adapter.targets.join(" | ")}`);
    return;
  }
  try {
    const started = await adapter.start(target);
    await deps.pending.begin(chatId, adapter, target, started);
    await send(ctx, started.html);
  } catch (err) {
    log.error({ tool: adapter.id, target, err: err instanceof Error ? err.message : String(err) }, "login start failed");
    await send(ctx, `Could not start the ${esc(adapter.title)} login: ${esc(err instanceof Error ? err.message : String(err))}`);
  }
}

/**
 * Called before the kernel sees a text message. Returns true when the message was the pasted
 * reply to a pending login (consumed: never reaches the kernel, never logged, deleted from the chat).
 */
export async function handleLoginReply(ctx: Context, deps: LoginDeps): Promise<boolean> {
  if (!isFounderDm(ctx, deps)) return false;
  const chatId = String(ctx.chat!.id);
  const pending = await deps.pending.peek(chatId);
  const text = ctx.message?.text?.trim() ?? "";
  if (!pending || !text || text.startsWith("/")) return false;

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
