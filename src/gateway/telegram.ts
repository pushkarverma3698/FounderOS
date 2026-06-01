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
function finalReply(res: { messages?: OfficeMessage[] }): string {
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

async function routeToOffice(ctx: Context): Promise<void> {
  const text = ctx.message?.text ?? "";
  const chatId = ctx.chat?.id ?? ctx.from?.id ?? "unknown";
  const config = { configurable: { thread_id: threadIdFor(chatId) } };

  log.info({ chatId, task: text.slice(0, 80) }, "Routing to office");
  await ctx.replyWithChatAction("typing");
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
    await ctx.reply(`💬 ${safeHtml(finalReply(res).slice(0, 3800))}`, { parse_mode: "HTML" });
  } catch (err) {
    clearInterval(typing);
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg, chatId }, "Office run failed");
    await ctx.reply(`❌ <b>Something went wrong</b>\n<code>${safeHtml(msg.slice(0, 400))}</code>`, {
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
    await ctx.reply(`💬 ${safeHtml(finalReply(res).slice(0, 3800))}`, { parse_mode: "HTML" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg, chatId }, "Office resume failed");
    await ctx.reply(`❌ <b>Resume failed</b>\n<code>${safeHtml(msg.slice(0, 400))}</code>`, {
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
        `🔒 Anything that leaves the building (email, LinkedIn, GitHub writes) asks for your approval first.`,
      { parse_mode: "HTML" },
    );
  });

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
