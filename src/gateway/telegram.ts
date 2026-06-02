/**
 * FounderOS v2 — Telegram Gateway
 * ================================
 * Drives the office (supervisor + department sub-agents) from Telegram.
 *
 * Flow:
 *   message → office.invoke({ messages }) on a per-chat thread
 *     → if the office paused for approval (a write tool called interrupt())
 *          → send an Approve/Reject card; STOP
 *          → on button tap → office.invoke(Command({ resume })) on the same thread
 *              → chained approvals are re-rendered; otherwise the final answer is sent
 *     → else → send the office's final reply
 *
 * Thread id = `turicks:{chatId}` — stable per chat so:
 *   - conversation memory persists across messages (checkpointer), and
 *   - the approval button can resume the exact paused run by rebuilding the id.
 */

import { Bot, InlineKeyboard, type Context } from "grammy";
import { Command } from "@langchain/langgraph";
import { HumanMessage } from "@langchain/core/messages";
import { env } from "../core/config.js";
import { logger } from "../infra/logger.js";
import { getOffice, getPendingApproval } from "../agents/office.js";
import type { ApprovalRequest } from "../agents/agent-tools.js";
import {
  getOutboundTargets,
  addOutboundTargets,
  removeOutboundTarget,
  clearOutboundTargets,
} from "../outbound/targets.js";
import { buildBatchPrompt, splitBatch, parseCompanyArgs } from "../outbound/batch.js";
import { getSystemStatus, formatStatusMessage } from "./status.js";
import { parseContextCommand, formatContextDisplay } from "./context-command.js";
import { getFounderContext, upsertFounderContext } from "../db/queries.js";

const log = logger.child({ module: "telegram" });

const TENANT = process.env["FOUNDER_TENANT"] ?? "turicks";

// ── Safe HTML ─────────────────────────────────────────────────────────────────

/** Escape special HTML characters for Telegram HTML parse mode. */
export function safeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Bot singleton ──────────────────────────────────────────────────────────────

let _bot: Bot | undefined;

export function getBot(): Bot {
  if (!_bot) _bot = new Bot(env.TELEGRAM_BOT_TOKEN);
  return _bot;
}

function threadIdFor(chatId: number | string): string {
  return `${TENANT}:${chatId}`;
}

// ── Result extraction ──────────────────────────────────────────────────────────

interface OfficeMessage {
  content: unknown;
  _getType?: () => string;
  tool_calls?: unknown[];
}

/** Pull the office's final human-readable reply (last AI message with text). */
export function finalReply(res: { messages?: OfficeMessage[] }): string {
  const msgs = res.messages ?? [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    const type = m._getType?.() ?? "";
    const text = typeof m.content === "string" ? m.content : "";
    if (type === "ai" && text.trim() && !(m.tool_calls && m.tool_calls.length > 0)) {
      return text.trim();
    }
  }
  return "✅ Done.";
}

/**
 * Scan the message trail for tool results that indicate a failure. Tools return
 * errors as their result string (they don't throw), so these never hit the
 * gateway's catch — we surface them explicitly so the founder always sees them.
 *
 * Bug fix (2026-06-02): removed trailing \b from regex so "failed" matches "fail",
 * "errors" matches "error", etc.
 */
export function collectToolErrors(res: { messages?: OfficeMessage[] }): string[] {
  const errs: string[] = [];
  for (const m of res.messages ?? []) {
    if ((m._getType?.() ?? "") !== "tool") continue;
    const c = typeof m.content === "string" ? m.content : "";
    if (/\b(fail|error|not set|not configured|cannot find|blocked|unauthor|invalid|denied)/i.test(c)) {
      errs.push(c.trim().slice(0, 300));
    }
  }
  return errs;
}

/** Send the office's result to Telegram — final reply plus any tool failures. */
async function sendResult(ctx: Context, res: { messages?: OfficeMessage[] }, chatId: number | string): Promise<void> {
  const reply = finalReply(res);
  const errs = collectToolErrors(res);

  let out = `💬 ${safeHtml(reply.slice(0, 3500))}`;
  if (errs.length > 0) {
    out += `\n\n⚠️ <b>Tool issue${errs.length > 1 ? "s" : ""}:</b>\n<code>${safeHtml(errs.join("\n").slice(0, 800))}</code>`;
  }
  await ctx.reply(out, { parse_mode: "HTML" });
  log.info({ chatId, replyPreview: reply.slice(0, 80), toolErrors: errs.length }, "Replied to Telegram");
}

// ── Approval card ──────────────────────────────────────────────────────────────

async function sendApprovalCard(ctx: Context, approval: ApprovalRequest): Promise<void> {
  const keyboard = new InlineKeyboard()
    .text("✅ Approve", "approve")
    .text("❌ Reject", "reject");

  const preview = approval.preview ? `\n\n<i>${safeHtml(approval.preview.slice(0, 1500))}</i>` : "";
  await ctx.reply(
    `${safeHtml(approval.title)}\n${safeHtml(approval.summary)}${preview}`,
    { parse_mode: "HTML", reply_markup: keyboard },
  );
}

// ── Route an incoming message into the office ──────────────────────────────────

/** Route the literal text of the incoming message into the office. */
async function routeToOffice(ctx: Context): Promise<void> {
  await runOfficeText(ctx, ctx.message?.text ?? "");
}

/**
 * Run an arbitrary prompt through the office on this chat's thread.
 * Shared by plain messages and commands (e.g. /outbound builds its own prompt).
 */
async function runOfficeText(ctx: Context, text: string): Promise<void> {
  const chatId = ctx.chat?.id ?? ctx.from?.id ?? "unknown";
  const config = { configurable: { thread_id: threadIdFor(chatId) } };

  log.info({ chatId, task: text.slice(0, 80) }, "Routing to office");
  // Typing indicator is best-effort — don't let it crash the handler
  ctx.replyWithChatAction("typing").catch(() => {});
  const typing = setInterval(() => {
    ctx.replyWithChatAction("typing").catch(() => {});
  }, 4000);

  try {
    const office = await getOffice();
    const res = (await office.invoke(
      { messages: [new HumanMessage(text)] },
      config,
    )) as { messages?: OfficeMessage[] };
    clearInterval(typing);

    const approval = await getPendingApproval(office, config);
    if (approval) {
      await sendApprovalCard(ctx, approval);
      return;
    }
    await sendResult(ctx, res, chatId);
  } catch (err) {
    clearInterval(typing);
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    log.error({ err: msg, chatId }, "Office run failed");
    await ctx.reply(`❌ <b>Error</b>\n<code>${safeHtml(msg.slice(0, 1200))}</code>`, {
      parse_mode: "HTML",
    });
  }
}

// ── Resume a paused run after an approval decision ─────────────────────────────

async function resumeOffice(ctx: Context, decision: "approved" | "rejected"): Promise<void> {
  const chatId = ctx.chat?.id ?? ctx.from?.id ?? "unknown";
  const config = { configurable: { thread_id: threadIdFor(chatId) } };

  try {
    const office = await getOffice();
    const res = (await office.invoke(
      new Command({ resume: decision }),
      config,
    )) as { messages?: OfficeMessage[] };

    // A run may pause again (e.g. research → then email approval).
    const next = await getPendingApproval(office, config);
    if (next) {
      await sendApprovalCard(ctx, next);
      return;
    }
    await sendResult(ctx, res, chatId);
  } catch (err) {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    log.error({ err: msg, chatId }, "Office resume failed");
    await ctx.reply(`❌ <b>Resume failed</b>\n<code>${safeHtml(msg.slice(0, 1200))}</code>`, {
      parse_mode: "HTML",
    });
  }
}

// ── Handlers ───────────────────────────────────────────────────────────────────

export function registerHandlers(bot: Bot): void {
  bot.command("start", async (ctx: Context) => {
    const name = ctx.from?.first_name ? ` ${ctx.from.first_name}` : "";
    await ctx.reply(
      `👋 <b>FounderOS${name}</b> — your AI chief of staff is live.\n\n` +
        `Just tell me what you need. I route it to the right department:\n` +
        `• <b>Research</b> — <i>"Research Stripe and summarise what they do"</i>\n` +
        `• <b>Comms</b> — <i>"Email alex@acme.com a short intro"</i> (you approve before it sends)\n` +
        `• <b>Engineering</b> — <i>"Write a TS function to validate emails"</i> / <i>"Open a GitHub issue on …"</i>\n\n` +
        `🎯 <b>Weekly outbound</b>\n` +
        `• <code>/target Acme Corp, Beta Ltd</code> — add prospects to this week's list\n` +
        `• <code>/targets</code> — show the list (<code>/targets clear</code> to empty it)\n` +
        `• <code>/outbound</code> — ICP-score the list (or <code>/outbound stripe.com</code> ad-hoc)\n` +
        `  then <i>"draft outreach to &lt;winner&gt;"</i> to send (you approve first)\n\n` +
        `⚙️ <b>System</b>\n` +
        `• <code>/status</code> — uptime, pending approvals, emails sent today\n` +
        `• <code>/context</code> — view/update your business context (clients, priorities)\n\n` +
        `🔒 Anything that leaves the building (email, LinkedIn, GitHub writes) asks for your approval first.`,
      { parse_mode: "HTML" },
    );
  });

  // ── Weekly outbound rhythm (Phase D) ──────────────────────────────────────
  // Deterministic list management (no LLM); /outbound routes a batched
  // prospecting prompt through the office (read-only ICP scoring, no HITL).

  bot.command("target", async (ctx: Context) => {
    const arg = (ctx.match ?? "").toString().trim();
    if (!arg) {
      await ctx.reply("Usage: <code>/target Acme Corp, Beta Ltd</code>", { parse_mode: "HTML" });
      return;
    }
    const { added, targets } = await addOutboundTargets(TENANT, parseCompanyArgs(arg));
    const msg =
      added.length > 0
        ? `🎯 Added: ${safeHtml(added.join(", "))}\nList now has <b>${targets.length}</b> target${targets.length === 1 ? "" : "s"}.`
        : `Nothing new to add (already on the list). List has <b>${targets.length}</b> target${targets.length === 1 ? "" : "s"}.`;
    await ctx.reply(msg, { parse_mode: "HTML" });
  });

  bot.command("targets", async (ctx: Context) => {
    const arg = (ctx.match ?? "").toString().trim().toLowerCase();
    if (arg === "clear") {
      await clearOutboundTargets(TENANT);
      await ctx.reply("🧹 Outbound target list cleared.");
      return;
    }
    const targets = await getOutboundTargets(TENANT);
    if (targets.length === 0) {
      await ctx.reply("No outbound targets yet. Add some: <code>/target Acme Corp</code>", { parse_mode: "HTML" });
      return;
    }
    const list = targets.map((t, i) => `${i + 1}. ${safeHtml(t)}`).join("\n");
    await ctx.reply(`🎯 <b>Outbound targets (${targets.length})</b>\n${list}\n\nScore them: <code>/outbound</code>`, {
      parse_mode: "HTML",
    });
  });

  bot.command("untarget", async (ctx: Context) => {
    const arg = (ctx.match ?? "").toString().trim();
    if (!arg) {
      await ctx.reply("Usage: <code>/untarget Acme Corp</code>", { parse_mode: "HTML" });
      return;
    }
    const { removed, targets } = await removeOutboundTarget(TENANT, arg);
    await ctx.reply(
      removed
        ? `✅ Removed ${safeHtml(arg)}. ${targets.length} target${targets.length === 1 ? "" : "s"} left.`
        : `"${safeHtml(arg)}" wasn't on the list.`,
      { parse_mode: "HTML" },
    );
  });

  bot.command("outbound", async (ctx: Context) => {
    const arg = (ctx.match ?? "").toString().trim();
    const targets = arg ? parseCompanyArgs(arg) : await getOutboundTargets(TENANT);

    if (targets.length === 0) {
      await ctx.reply(
        "No targets to score. Add some with <code>/target Acme Corp</code>, then <code>/outbound</code> — or score ad-hoc: <code>/outbound stripe.com</code>.",
        { parse_mode: "HTML" },
      );
      return;
    }

    const { batch, overflow } = splitBatch(targets);
    if (overflow.length > 0) {
      await ctx.reply(
        `🎯 Scoring the first <b>${batch.length}</b> of ${targets.length}. Run <code>/outbound</code> again later for the remaining ${overflow.length}.`,
        { parse_mode: "HTML" },
      );
    }
    await runOfficeText(ctx, buildBatchPrompt(batch));
  });

  // ── /status — system health snapshot ──────────────────────────────────────

  bot.command("status", async (ctx: Context) => {
    try {
      const data = await getSystemStatus();
      await ctx.reply(formatStatusMessage(data), { parse_mode: "HTML" });
    } catch (err) {
      await ctx.reply(`❌ Status check failed: ${safeHtml((err as Error).message)}`, { parse_mode: "HTML" });
    }
  });

  // ── /context — view / update founder business context ─────────────────────

  bot.command("context", async (ctx: Context) => {
    const arg = (ctx.match ?? "").toString().trim();
    const parsed = parseContextCommand(arg);

    if (parsed.action === "error") {
      await ctx.reply(`❌ ${safeHtml(parsed.message)}`, { parse_mode: "HTML" });
      return;
    }

    if (parsed.action === "show") {
      const storedCtx = await getFounderContext(TENANT);
      await ctx.reply(formatContextDisplay(storedCtx), { parse_mode: "HTML" });
      return;
    }

    // action === "set"
    const { key, value } = parsed;
    // Coerce comma-separated values to array for list keys
    const listKeys = new Set(["active_clients", "current_priorities", "open_deals", "next_actions"]);
    const update: Record<string, unknown> = listKeys.has(key)
      ? { [key]: value.split(",").map((v) => v.trim()).filter(Boolean) }
      : { [key]: value };

    await upsertFounderContext(TENANT, update);
    await ctx.reply(`✅ Context updated: <b>${safeHtml(key)}</b> → <i>${safeHtml(value)}</i>`, {
      parse_mode: "HTML",
    });
    log.info({ key, value }, "Founder context updated via /context command");
  });

  // ── Free-text messages → office ────────────────────────────────────────────

  bot.on("message:text", async (ctx: Context) => {
    const text = ctx.message?.text ?? "";
    if (text.startsWith("/")) return; // ignore other slash commands for now
    log.info({ from: ctx.from?.id, text: text.slice(0, 80) }, "Message received");
    await routeToOffice(ctx);
  });

  bot.on("callback_query:data", async (ctx: Context) => {
    const data = ctx.callbackQuery?.data ?? "";
    if (data !== "approve" && data !== "reject") {
      await ctx.answerCallbackQuery({ text: "Unknown action" });
      return;
    }
    const decision = data === "approve" ? "approved" : "rejected";
    await ctx.answerCallbackQuery({ text: decision === "approved" ? "✅ Approved" : "❌ Rejected" });
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
    } catch {
      /* best-effort */
    }
    await resumeOffice(ctx, decision);
  });

  bot.catch((err) => {
    log.error({ err: err.message }, "Unhandled bot error");
  });
}

// ── Plain sender (used by schedulers/agents to push a message) ─────────────────

export async function sendToChat(text: string, parseMode: "HTML" | "Markdown" = "HTML"): Promise<void> {
  const bot = getBot();
  await bot.api.sendMessage(env.TELEGRAM_CHAT_ID, text, { parse_mode: parseMode });
}

// ── Lifecycle ───────────────────────────────────────────────────────────────────

export async function startBot(): Promise<void> {
  const bot = getBot();
  registerHandlers(bot);
  log.info("Telegram bot starting (long polling)…");
  bot.start().catch((err) => {
    log.error({ err: (err as Error).message }, "Bot polling crashed");
    process.exit(1);
  });
}

export async function stopBot(): Promise<void> {
  if (_bot) {
    await _bot.stop();
    _bot = undefined;
    log.info("Telegram bot stopped");
  }
}
