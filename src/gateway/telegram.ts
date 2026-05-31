/**
 * FounderOS — Telegram Bot Gateway
 * ==================================
 * grammy-based bot with:
 *  - Topic-group routing (Boardroom / Turicks / Social → CEO supervisor)
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
 * All topics (Boardroom, Turicks, Social, Think Tank) route to turicks —
 * the CEO supervisor picks the department from there.
 */
function topicToTenant(_threadTopicId: number | undefined): string {
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

  // Send typing indicator and refresh every 4s (graph.invoke can take 60–120s)
  await ctx.replyWithChatAction("typing");
  const typingInterval = setInterval(() => {
    ctx.replyWithChatAction("typing").catch(() => {/* ignore — non-fatal */});
  }, 4000);

  try {
    const graph = await getGraph();
    if (!graph) throw new Error("Graph not initialized");

    const result = await graph.invoke(
      { task, tenant_id: tenantId },
      { configurable: { thread_id: threadId } },
    );

    clearInterval(typingInterval);

    const raw = result.result ? String(result.result) : null;

    // Detect if result is JSON (pod output) vs plain text (direct_answer / CEO chat)
    let output: string;
    if (!raw) {
      output = "✅ Task processed (no output)";
    } else {
      const isJson = raw.trimStart().startsWith("{") || raw.trimStart().startsWith("[");
      output = isJson
        ? `✅ <b>Done</b>\n\n<pre>${safeHtml(raw.slice(0, 3000))}</pre>`
        : `💬 ${safeHtml(raw.slice(0, 3000))}`;
    }

    await ctx.reply(output, {
      parse_mode: "HTML",
      ...(threadTopicId ? { message_thread_id: threadTopicId } : {}),
    });
  } catch (err) {
    clearInterval(typingInterval);
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

// ── /prospect command handler ─────────────────────────────────────────────────

/**
 * Handle /prospect <url|company-name> command.
 * Routes straight to the prospecting department — bypasses supervisor classification.
 * The prospecting pod will disambiguate, research, and score the lead.
 *
 * Example: /prospect https://acme.com
 *          /prospect Acme Corp
 */
async function handleProspectCommand(ctx: Context): Promise<void> {
  const text = ctx.message?.text ?? "";
  const threadTopicId = ctx.message?.message_thread_id;
  const userId = String(ctx.from?.id ?? "unknown");
  const tenantId = topicToTenant(threadTopicId);

  // Extract the raw input after "/prospect "
  const rawInput = text.replace(/^\/prospect\s*/i, "").trim();
  if (!rawInput) {
    await ctx.reply(
      "❓ Usage: <code>/prospect &lt;url or company name&gt;</code>\n\nExample: <code>/prospect acme.com</code>",
      { parse_mode: "HTML" },
    );
    return;
  }

  const threadId = `${tenantId}:${userId}:${crypto.randomUUID()}`;
  log.info({ userId, tenantId, threadId, rawInput }, "Prospect command received");

  await ctx.reply(
    `🔍 Researching <b>${safeHtml(rawInput)}</b>…\n<i>This takes ~30s. I'll score it against our ICP and let you know if it's worth pursuing.</i>`,
    {
      parse_mode: "HTML",
      ...(threadTopicId ? { message_thread_id: threadTopicId } : {}),
    },
  );

  // Keep typing indicator alive during long graph execution
  const prospectTypingInterval = setInterval(() => {
    ctx.replyWithChatAction("typing").catch(() => {/* ignore */});
  }, 4000);

  try {
    const graph = await getGraph();
    if (!graph) throw new Error("Graph not initialized");

    const result = await graph.invoke(
      {
        task: rawInput,
        tenant_id: tenantId,
        department: "prospecting",
      },
      { configurable: { thread_id: threadId } },
    );

    clearInterval(prospectTypingInterval);

    // Parse the JSON summary written by prospectingNode
    let summary: Record<string, unknown> = {};
    try {
      summary = JSON.parse(result.result ?? "{}") as Record<string, unknown>;
    } catch {
      // fallback — show raw
    }

    const tier = summary.outreach_tier as string | null ?? null;
    const score = typeof summary.icp_score === "number"
      ? `${Math.round((summary.icp_score as number) * 100)}%`
      : "—";
    const rationale = summary.icp_rationale as string ?? "";
    const company = (summary.company_name as string | null) ?? rawInput;

    let output: string;
    if (tier) {
      const tierLabel = tier === "ceo" ? "🏆 CEO-tier" : "👔 MD-tier";
      output =
        `✅ <b>${safeHtml(company)}</b> — <b>Qualified</b> ${tierLabel}\n` +
        `ICP score: <b>${score}</b>\n\n` +
        `<i>${safeHtml(rationale.slice(0, 400))}</i>\n\n` +
        `📬 Routing to Sales pod for outreach draft…`;
    } else {
      output =
        `❌ <b>${safeHtml(company)}</b> — <b>Disqualified</b>\n` +
        `ICP score: <b>${score}</b>\n\n` +
        `<i>${safeHtml(rationale.slice(0, 400))}</i>`;
    }

    await ctx.reply(output, {
      parse_mode: "HTML",
      ...(threadTopicId ? { message_thread_id: threadTopicId } : {}),
    });
  } catch (err) {
    clearInterval(prospectTypingInterval);
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg, rawInput, threadId }, "Prospect command failed");
    await ctx.reply(
      `❌ <b>Prospecting failed</b>\n\n<code>${safeHtml(msg.slice(0, 500))}</code>`,
      {
        parse_mode: "HTML",
        ...(threadTopicId ? { message_thread_id: threadTopicId } : {}),
      },
    );
  }
}

// ── Handlers ──────────────────────────────────────────────────────────────────

/**
 * Register all bot handlers.
 * Called once at startup before bot.start().
 */
export function registerHandlers(bot: Bot): void {
  // ── /start command ────────────────────────────────────────────────────────

  bot.command("start", async (ctx: Context) => {
    const name = ctx.from?.first_name ? ` ${ctx.from.first_name}` : "";
    await ctx.reply(
      `👋 <b>FounderOS${name}</b> — your AI operating system is live.\n\n` +
      `<b>Commands:</b>\n` +
      `• <code>/prospect &lt;url or company&gt;</code> — ICP score + sales routing\n` +
      `• <code>/task &lt;description&gt;</code> — any task → correct department\n\n` +
      `<b>Or just message me:</b>\n` +
      `• <i>"Draft a LinkedIn post about AI agents"</i>\n` +
      `• <i>"Research Stripe and write a cold email"</i>\n` +
      `• <i>"Build a webhook handler for Stripe"</i>\n\n` +
      `All tasks go through the CEO supervisor → routed to Sales, Engineering, Marketing, Social, or Prospecting pods.\n\n` +
      `💡 <i>Tip: HITL gates protect every outbound action — you approve before anything is sent.</i>`,
      {
        parse_mode: "HTML",
        ...(ctx.message?.message_thread_id ? { message_thread_id: ctx.message.message_thread_id } : {}),
      },
    );
  });

  // ── /prospect command ────────────────────────────────────────────────────

  bot.command("prospect", async (ctx: Context) => {
    await handleProspectCommand(ctx);
  });

  // ── Incoming messages ────────────────────────────────────────────────────

  bot.on("message:text", async (ctx: Context) => {
    const threadTopicId = ctx.message?.message_thread_id;
    const text = ctx.message?.text ?? "";

    // Don't double-handle /prospect commands (grammy routes commands first)
    if (text.startsWith("/prospect")) return;

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
