/**
 * FounderOS — /login
 * ==================
 * `/login`                  status of every credential, and how to renew one
 * `/login <tool> [target]`  start a renewal; the next message he sends is the pasted code
 * `/login <tool> add <name>` / `remove <name>`  for tools with several accounts (Google)
 * `/login <tool> logout [name]`  delete the stored credential and prove it with a call that now fails
 * `/login history`         the last logins, logouts and removals
 *
 * Founder's private chat only (not a group, not an allow-listed guest): a pasted code or token
 * is a credential, and a group member must neither start a login nor have a message swallowed.
 */

import type { Context } from "grammy";
import { classifyChatAccess, type ChatAccessConfig } from "../chat-access.js";
import { splitForTelegram } from "../format.js";
import { childLogger } from "../../infra/logger.js";
import { historyText, type LoginAudit, type LoginEvent } from "./login-audit.js";
import { PendingLogins } from "./pending.js";
import { LOGIN_ADAPTERS } from "./registry.js";
import type { LoginAdapter, LoginTargetStatus } from "./types.js";

const log = childLogger({ module: "gateway:login" });

export interface LoginDeps {
  readonly adapters: readonly LoginAdapter[];
  readonly pending: PendingLogins;
  readonly access: ChatAccessConfig;
  /** Where login, logout and remove events are recorded. Absent in tests that do not care. */
  readonly audit?: LoginAudit;
}

export function defaultLoginDeps(access: ChatAccessConfig, audit?: LoginAudit): LoginDeps {
  return { adapters: LOGIN_ADAPTERS, pending: new PendingLogins(), access, ...(audit ? { audit } : {}) };
}

/** A failed audit write is logged and never changes what the founder is told: the login itself already happened. */
async function record(deps: LoginDeps, event: LoginEvent): Promise<void> {
  // allow-failopen: the audit row is a trail, not a gate; the login/logout outcome stands and the failure is logged.
  await deps.audit?.record(event).catch((err: unknown) => log.error({ tool: event.tool, kind: event.kind, err: err instanceof Error ? err.message : String(err) }, "login audit write failed"));
}

const EMAIL_RE = /^[^\s@<>&"]+@[^\s@<>&"]+\.[^\s@<>&"]+$/;

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
      const renew = `/login ${a.id}${a.targets.length > 1 ? ` ${a.targets.join("|")}` : ""}${a.acceptsEmailHint ? " [email]" : ""}`;
      return a.addProblem ? `${renew}\n/login ${a.id} add &lt;name&gt; · /login ${a.id} remove &lt;name&gt;` : renew;
    })
    .join("\n");
  const out = deps.adapters.filter((a) => a.logout).map((a) => `/login ${a.id} logout${a.targets.length > 1 ? " &lt;name&gt;" : ""}`);
  return `${blocks.join("\n\n")}\n\nRenew one:\n${usage}${out.length ? `\n\nSign out (deletes the login, keeps no copy):\n${out.join("\n")}` : ""}\n\nWho signed in or out, and when: /login history`;
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
  if (toolArg === "history") {
    try {
      await send(ctx, deps.audit ? historyText(await deps.audit.recent(10)) : "Login events are not being recorded in this setup.");
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, "login history read failed");
      await send(ctx, "Could not read the login history: the database did not answer.");
    }
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
    await removeTarget(ctx, deps, adapter, nameArg ?? "");
    return;
  }
  if (targetArg === "logout") {
    await logoutTarget(ctx, deps, adapter, nameArg ?? "");
    return;
  }
  const hint = adapter.acceptsEmailHint && targetArg !== undefined && EMAIL_RE.test(targetArg) ? targetArg : undefined;
  const word = hint ? undefined : targetArg;
  const adding = word === "add" && adapter.addProblem !== undefined;
  const target = adding ? (nameArg ?? "") : word || (adapter.targets.length === 1 ? adapter.targets[0]! : "");
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
    const started = hint ? await adapter.start(target, hint) : await adapter.start(target);
    await deps.pending.begin(chatId, adapter, target, started);
    await send(ctx, `${started.html}\n\nChanged your mind? /login cancel`);
  } catch (err) {
    log.error({ tool: adapter.id, target, err: err instanceof Error ? err.message : String(err) }, "login start failed");
    await record(deps, { tool: adapter.id, target, kind: "login", ok: false, detail: `could not start: ${err instanceof Error ? err.message : String(err)}` });
    await send(ctx, `Could not start the ${esc(adapter.title)} login: ${esc(err instanceof Error ? err.message : String(err))}`);
  }
}

async function removeTarget(ctx: Context, deps: LoginDeps, adapter: LoginAdapter, name: string): Promise<void> {
  if (!adapter.targets.includes(name)) {
    await send(ctx, `Which one? /login ${adapter.id} remove ${adapter.targets.join(" | ")}`);
    return;
  }
  try {
    const done = await adapter.remove!(name);
    await record(deps, { tool: adapter.id, target: name, kind: "remove", ok: done.ok, detail: done.ok ? undefined : done.html });
    await send(ctx, done.html);
  } catch (err) {
    log.error({ tool: adapter.id, target: name, err: err instanceof Error ? err.message : String(err) }, "login remove failed");
    await record(deps, { tool: adapter.id, target: name, kind: "remove", ok: false, detail: err instanceof Error ? err.message : String(err) });
    await send(ctx, `Could not remove ${esc(name)}: ${esc(err instanceof Error ? err.message : String(err))}`);
  }
}

async function logoutTarget(ctx: Context, deps: LoginDeps, adapter: LoginAdapter, name: string): Promise<void> {
  if (!adapter.logout) {
    await send(ctx, `${esc(adapter.title)} has no sign-out here.`);
    return;
  }
  const target = name || (adapter.targets.length === 1 ? adapter.targets[0]! : "");
  if (!adapter.targets.includes(target)) {
    await send(ctx, `Which one? /login ${adapter.id} logout ${adapter.targets.join(" | ")}`);
    return;
  }
  // A login waiting for a paste would be completed by the next message after the sign-out: drop it first.
  await deps.pending.drop(String(ctx.chat!.id));
  try {
    const done = await adapter.logout(target);
    await record(deps, { tool: adapter.id, target, kind: "logout", ok: done.ok, detail: done.ok ? undefined : done.html });
    await send(ctx, done.html);
  } catch (err) {
    log.error({ tool: adapter.id, target, err: err instanceof Error ? err.message : String(err) }, "logout failed");
    await record(deps, { tool: adapter.id, target, kind: "logout", ok: false, detail: err instanceof Error ? err.message : String(err) });
    await send(ctx, `Could not sign ${esc(adapter.title)} out: ${esc(err instanceof Error ? err.message : String(err))}`);
  }
}

/**
 * Codes, callback URLs and tokens are one run of characters with at least one digit. Anything else
 * ("what's on today", "yesterday") is a normal message and goes to the kernel; the attempt stays open.
 */
const looksLikePaste = (text: string): boolean => !/\s/.test(text) && /\d/.test(text);

/**
 * A credential that picked up whitespace on the way (a wrapped token, a URL with a stray space) is
 * still a credential: while a login is pending it is consumed, not handed to the model and stored.
 */
const CREDENTIAL_MARKER_RE = /sk-ant-|[?&]code=|https?:\/\/localhost/i;

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
  const credential = CREDENTIAL_MARKER_RE.test(text);
  if (!credential && !looksLikePaste(text)) return false;

  let deleted = true;
  // allow-failopen: the paste is a credential; if Telegram refuses the delete, finishing the login still matters more. The reply says so.
  await ctx.deleteMessage().catch(() => { deleted = false; });
  const notDeleted = deleted ? "" : "\n\n⚠️ I could not delete your message. Delete it yourself: it still holds the code.";
  let result;
  try {
    result = await pending.adapter.finish(pending.target, credential ? text.replace(/\s+/g, "") : text, pending.started.state);
  } catch (err) {
    log.error({ tool: pending.adapter.id, target: pending.target, err: err instanceof Error ? err.message : String(err) }, "login finish failed");
    result = { ok: false, html: `The ${esc(pending.adapter.title)} login failed: ${esc(err instanceof Error ? err.message : String(err))}` };
  }
  await record(deps, { tool: pending.adapter.id, target: pending.target, kind: "login", ok: result.ok, detail: result.ok ? undefined : result.html });
  // A failed paste keeps the attempt open (a typo should not cost a new link); success closes it, or hands over to its next step.
  if (result.ok && result.next) await deps.pending.begin(chatId, pending.adapter, pending.target, result.next);
  else if (result.ok || result.ended) await deps.pending.drop(chatId);
  await send(ctx, (result.next ? `${result.html}\n\nChanged your mind? /login cancel` : result.html) + notDeleted);
  return true;
}
