/**
 * FounderOS — Proactive Scheduler
 * =================================
 * node-cron jobs that push proactive messages to the founder's Telegram.
 *
 * Jobs:
 *  1. Monday 8:00am  — Weekly brief (context-driven, no LLM call)
 *  2. Daily 09:00am  — Stale approval reminder (HITL items > 12 hours old)
 *
 * The scheduler uses sendToChat() to push messages directly to TELEGRAM_CHAT_ID.
 * It does NOT invoke the office graph (no LLM cost for routine reminders).
 * The Monday brief IS LLM-generated (one model call per week — cheap).
 *
 * Architecture note: scheduler is started ONCE in index.ts after the office
 * compiles. It accesses the DB directly — no need to go through the graph.
 */

import cron from "node-cron";
import { HumanMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { getFounderContext, getPendingInterrupt } from "../db/queries.js";
import { getOutboundTargets } from "../outbound/targets.js";
import { sendToChat } from "../gateway/telegram.js";
import { buildOffice } from "../agents/office.js";
import { SCHEDULER_BRIEF_PROMPT } from "../agents/system-prompts.js";
import { childLogger } from "./logger.js";
import { env, TENANT } from "../core/config.js";

const log = childLogger({ module: "scheduler" });


// ── Monday brief ──────────────────────────────────────────────────────────────

/**
 * Build a concise context string for the LLM from the stored founder context.
 * Pure function — extracted for testability.
 */
export function buildContextText(ctx: Record<string, unknown>): string {
  const contextLines: string[] = [];
  for (const [key, value] of Object.entries(ctx)) {
    if (key === "last_updated") continue;
    const val = Array.isArray(value)
      ? (value as string[]).join(", ") || "none"
      : String(value || "none");
    contextLines.push(`${key}: ${val}`);
  }
  return contextLines.length > 0
    ? contextLines.join("\n")
    : "No context stored yet. Defaults:\nactive_clients: none\nopen_deals: none\ncurrent_priorities: review pipeline, post on LinkedIn, run outreach\nnext_actions: none";
}

/** Format the founder context into a monday brief (with an LLM call). */
async function sendMondayBrief(): Promise<void> {
  log.info("Generating Monday brief…");

  const ctx = await getFounderContext(TENANT);
  const today = new Date().toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  const contextText = buildContextText(ctx);

  // Use a fresh MemorySaver office (no checkpoint persistence for scheduler tasks)
  const office = buildOffice(new MemorySaver());
  const config = { configurable: { thread_id: `${TENANT}:scheduler:monday` } };

  const prompt = `${SCHEDULER_BRIEF_PROMPT}\n\nToday is: ${today}\n\nFounder context:\n${contextText}`;

  if (!prompt || prompt.trim().length === 0) {
    log.error({}, "Scheduler prompt is empty, aborting");
    return;
  }

  const res = (await office.invoke(
    { messages: [new HumanMessage(prompt)] },
    config,
  )) as { messages: Array<{ content: unknown; _getType?: () => string; tool_calls?: unknown[] }> };

  // Extract last AI reply
  let brief = "📅 Monday Brief — no content generated.";
  for (let i = res.messages.length - 1; i >= 0; i--) {
    const m = res.messages[i]!;
    if (
      m._getType?.() === "ai" &&
      typeof m.content === "string" &&
      m.content.trim() &&
      !(m.tool_calls?.length)
    ) {
      brief = m.content.trim();
      break;
    }
  }

  await sendToChat(brief, "Markdown");
  log.info("Monday brief sent");
}

// ── Stale approval reminder ───────────────────────────────────────────────────

/** Check for HITL approvals pending > 12 hours and send a Telegram reminder. */
async function sendStaleApprovalReminder(): Promise<void> {
  // We can't directly query all threads without knowing the thread IDs.
  // Instead, query hitl_approvals directly for stale pending rows.
  // This is handled via the DB directly (not through getPendingInterrupt which requires thread_id).
  const { getDb } = await import("../db/client.js");
  const { hitlApprovals } = await import("../db/schema.js");
  const { and, eq, lt } = await import("drizzle-orm");

  const db = getDb();
  const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000);

  const stale = await db
    .select({
      thread_id: hitlApprovals.thread_id,
      callback_data: hitlApprovals.callback_data,
      created_at: hitlApprovals.created_at,
    })
    .from(hitlApprovals)
    .where(
      and(
        eq(hitlApprovals.status, "pending"),
        lt(hitlApprovals.created_at, twelveHoursAgo),
      ),
    );

  if (stale.length === 0) return;

  const lines = stale.map((row) => {
    const age = Math.round((Date.now() - (row.created_at?.getTime() ?? 0)) / 3_600_000);
    return `• Thread: \`${row.thread_id}\` — pending for ~${age}h`;
  });

  const msg =
    `⏰ <b>Pending approval reminder</b>\n\n` +
    `You have ${stale.length} approval${stale.length > 1 ? "s" : ""} waiting:\n${lines.join("\n")}\n\n` +
    `Send a message to the bot to resume that conversation.`;

  await sendToChat(msg, "HTML");
  log.info({ count: stale.length }, "Stale approval reminder sent");
}

// ── Weekly outbound nudge ─────────────────────────────────────────────────────

/** Monday nudge to run the weekly outbound batch (no LLM — reads founder_context). */
async function sendOutboundNudge(): Promise<void> {
  const targets = await getOutboundTargets(TENANT);
  const msg =
    targets.length > 0
      ? `🎯 <b>Outbound — new week</b>\n\nYou have <b>${targets.length}</b> target${targets.length === 1 ? "" : "s"} queued. Send <code>/outbound</code> to ICP-score them, then draft the winners.`
      : `🎯 <b>Outbound — new week</b>\n\nNo prospects queued yet. Add some as you spot them: <code>/target Acme Corp</code> — then <code>/outbound</code> Monday to score the batch.`;
  await sendToChat(msg, "HTML");
  log.info({ targets: targets.length }, "Outbound nudge sent");
}

// ── Scheduler boot ────────────────────────────────────────────────────────────

export function startScheduler(): void {
  // Monday 8:00am (local server time — deploy in your timezone)
  cron.schedule("0 8 * * 1", () => {
    sendMondayBrief().catch((err) => {
      log.error({ err: (err as Error).message }, "Monday brief failed");
      sendToChat(`⚠️ Monday brief failed: ${(err as Error).message}`, "HTML").catch(() => {});
    });
  });

  // Daily 9:00am — stale approval check
  cron.schedule("0 9 * * *", () => {
    sendStaleApprovalReminder().catch((err) => {
      log.error({ err: (err as Error).message }, "Stale approval check failed");
    });
  });

  // Monday 8:05am — outbound nudge (just after the brief)
  cron.schedule("5 8 * * 1", () => {
    sendOutboundNudge().catch((err) => {
      log.error({ err: (err as Error).message }, "Outbound nudge failed");
    });
  });

  log.info("Scheduler started — Monday brief (Mon 8am) + outbound nudge (Mon 8:05am), stale approval check (daily 9am)");
}
