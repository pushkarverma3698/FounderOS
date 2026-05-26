/**
 * FounderOS — Telegram Bot Gateway
 * ==================================
 * grammy-based bot with:
 *  - Topic-group routing (Boardroom / Turicks / Naggar / Social → CEO supervisor)
 *  - HITL callback handler (inline keyboard approve/reject)
 *  - Safe HTML escaping (prevent injection in bot replies)
 *  - Immediate ACK on every callback_query (no spinner left on buttons)
 */

import { Bot, InlineKeyboard, type Context } from "grammy";
import { env } from "../core/config.js";
import { logger } from "../infra/logger.js";
import { resolveHITL, formatHITLMessage } from "./hitl.js";
import { getGraph } from "../agents/graph.js";

const log = logger.child({ module: "telegram" });

// ── Safe HTML ─────────────────────────────────────────────────────────────────

/** Escape special HTML characters for Telegram HTML parse mode. */
export function safeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Bot Instance ──────────────────────────────────────────────────────────────

let _bot: Bot | undefined;

export function getBot(): Bot {
  if (!_bot) {
    _bot = new Bot(env.TELEGRAM_BOT_TOKEN);
  }
  return _bot;
}

// ── Topic → Tenant mapping ────────────────────────────────────────────────────

/**
 * Resolve which company tenant owns a given Telegram topic.
 * Falls back to "turicks" for unknown/boardroom topics.
 */
function topicToTenant(threadTopicId: number | undefined): string {
  if (threadTopicId === env.TOPIC_NAGGAR) return "naggar";
  // Boardroom, Turicks, Social, Think Tank → turicks (CEO supervisor picks department)
  return "turicks";
}

// ── Route message to FounderGraph ─────────────────────────────────────────────

/**
 * Invoke the FounderGraph with the incoming message as the task.
 * Generates a fresh thread_id per message (stateless for now).
 * Replies with the graph's result or an error message.
 */
async function routeToGraph(ctx: Context): Promise<void> {
  const task = ctx.message?.text ?? "";
  const userId = String(ctx.from?.id ?? "unknown");
  const threadTopicId = ctx.message?.message_thread_id;
  const tenantId = topicToTenant(threadTopicId);
  const threadId = `${tenantId}:${userId}:${crypto.randomUUID()}`;

  log.info({ userId, tenantId, threadId, task: task.slice(0, 80) }, "Routing to FounderGraph");

  // Immediate typing indicator
  await ctx.replyWithChatAction("typing");

  try {
    const graph = await getGraph();
    if (!graph) throw new Error("Graph not initialized");

    const result = await graph.invoke(
      { task, tenant_id: tenantId },
      { configurable: { thread_id: threadId } },
    );

    const raw = result.result ? String(result.result) : null;
    const output = raw
      ? `✅ <b>Done</b>\n\n<pre>${safeHtml(raw.slice(0, 3000))}</pre>`
      : "✅ Task processed (no output)";

    await ctx.reply(output, {
      parse_mode: "HTML",
      ...(threadTopicId ? { message_thread_id: threadTopicId } : {}),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg, threadId }, "Graph execution failed");
    await ctx.reply(
      `❌ <b>Error</b>\n\n<code>${safeHtml(msg.slice(0, 500))}</code>`,
      {
        parse_mode: "HTML",
        ...(threadTopicId ? { message_thread_id: threadTopicId } : {}),
      },
    );
  }
}

// ── HITL Message Sender ───────────────────────────────────────────────────────

/**
 * Send an approval-request message with Approve / Reject inline keyboard.
 * Called from hitl.ts via the injected sendFn.
 * Returns the Telegram message_id (stored in interrupt_registry for later edits).
 */
export async function sendHITLMessage(
  topicId: number,
  interruptId: string,
  summary: string,
  draft: string,
  agent: string,
): Promise<number> {
  const bot = getBot();
  const text = formatHITLMessage(summary, draft, interruptId, agent);

  const keyboard = new InlineKeyboard()
    .text("✅ Approve", `approve:${interruptId}`)
    .text("❌ Reject", `reject:${interruptId}`);

  const msg = await bot.api.sendMessage(env.TELEGRAM_CHAT_ID, text, {
    parse_mode: "HTML",
    ...(topicId ? { message_thread_id: topicId } : {}),
    reply_markup: keyboard,
  });

  log.info({ interrupt_id: interruptId, message_id: msg.message_id, agent }, "HITL message sent");
  return msg.message_id;
}

// ── Handlers ──────────────────────────────────────────────────────────────────

/**
 * Register all bot handlers.
 * Called once at startup before bot.start().
 */
export function registerHandlers(bot: Bot): void {
  // ── Incoming messages ────────────────────────────────────────────────────

  bot.on("message:text", async (ctx: Context) => {
    const threadTopicId = ctx.message?.message_thread_id;
    const text = ctx.message?.text ?? "";
    log.info({ from: ctx.from?.id, topic: threadTopicId, text: text.slice(0, 80) }, "Message received");
    await routeToGraph(ctx);
  });

  // ── HITL callbacks ───────────────────────────────────────────────────────

  bot.on("callback_query:data", async (ctx: Context) => {
    const data = ctx.callbackQuery?.data ?? "";

    if (data.startsWith("approve:") || data.startsWith("reject:")) {
      const colonIdx = data.indexOf(":");
      const action = data.slice(0, colonIdx);
      const interruptId = data.slice(colonIdx + 1);
      const decision = action === "approve" ? "approved" : "rejected";
      const emoji = decision === "approved" ? "✅" : "❌";

      // 1. Immediate ACK — removes the spinner on the user's phone
      await ctx.answerCallbackQuery({ text: `${emoji} ${decision}` });

      // 2. Remove inline keyboard right away (prevents double-tap race)
      try {
        await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
      } catch {
        // Non-fatal — message may already have been edited
      }

      // 3. Resume the suspended graph
      const resolved = await resolveHITL(interruptId, decision);

      // 4. Update message with final status
      const statusLine = resolved
        ? `\n\n${emoji} <b>${decision === "approved" ? "Approved" : "Rejected"}</b> — graph resumed`
        : `\n\n⚠️ <b>Already resolved or expired</b>`;

      try {
        const original = ctx.callbackQuery?.message?.text ?? "";
        await ctx.editMessageText(
          safeHtml(original) + statusLine,
          { parse_mode: "HTML" },
        );
      } catch {
        // Non-fatal — best-effort update
      }

      return;
    }

    // Unknown callback — ack to clear spinner
    await ctx.answerCallbackQuery({ text: "Unknown action" });
  });

  // ── Error handler ────────────────────────────────────────────────────────

  bot.catch((err) => {
    log.error({ err: err.message }, "Unhandled bot error");
  });
}

// ── Send helpers ──────────────────────────────────────────────────────────────

/**
 * Send a plain message to a specific Telegram topic.
 * Used by agents to report results outside the normal request/reply flow.
 */
export async function sendToTopic(
  topicId: number,
  text: string,
  parseMode: "HTML" | "Markdown" = "HTML",
): Promise<void> {
  const bot = getBot();
  try {
    await bot.api.sendMessage(env.TELEGRAM_CHAT_ID, text, {
      message_thread_id: topicId || undefined,
      parse_mode: parseMode,
    });
  } catch (err) {
    log.error({ topicId, err }, "Failed to send Telegram message");
    throw err;
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

export async function startBot(): Promise<void> {
  const bot = getBot();
  registerHandlers(bot);
  log.info("Telegram bot starting (long polling)…");
  // Fire-and-forget — runs until process exits or bot.stop() is called
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
