/**
 * FounderOS v2 — Office Run-Loop
 * ===============================
 * The heart of the gateway: turning one Telegram message into one office run,
 * including the three guards that keep a per-chat thread healthy.
 *
 * Flow (runOfficeText):
 *   message → resolve any stale approval → recover any wedged thread
 *           → capture turn boundary → office.invoke({ messages })
 *           → if it paused for approval → send Approve/Reject card; STOP
 *           → else → send the fresh reply, record memory, trim history
 *
 * Resume (resumeOffice): a button tap re-enters the SAME thread with
 *   Command({ resume }) so the paused write tool runs (approve) or no-ops (reject).
 *
 * This module is UI-agnostic about *which* commands exist — it only knows how to
 * run text through the office. Bot lifecycle and handler registration live in
 * telegram.ts; the highest-risk loop logic lives here so it is easy to find and
 * unit-test in isolation.
 */

import { InlineKeyboard, type Context } from "grammy";
import { Command, GraphRecursionError } from "@langchain/langgraph";
import { RemoveMessage, type BaseMessage } from "@langchain/core/messages";
import { TENANT, OFFICE_RECURSION_LIMIT, HISTORY_KEEP_TURNS } from "../core/config.js";
import { computeHistoryTrim } from "../infra/history-window.js";
import { logger } from "../infra/logger.js";
import { getOffice, getPendingApproval } from "../agents/office.js";
import type { ApprovalRequest } from "../agents/agent-tools.js";
import { clearThreadCheckpoints } from "../infra/checkpointer.js";
import { markdownToTelegramHtml, splitForTelegram, TELEGRAM_MAX } from "./format.js";
import { buildOfficeInput } from "./pre-router.js";
import { assertNonEmptyMessages } from "../infra/office-guard.js";
import { isWedgedState, type WedgeState } from "../infra/wedge.js";
import { BudgetExceededError, BudgetGuardCallback, createRunBudget } from "../infra/budget.js";
import { recordConversationEnd } from "../infra/conversation-recorder.js";

const log = logger.child({ module: "office-run" });

// ── Safe HTML ─────────────────────────────────────────────────────────────────

/** Escape special HTML characters for Telegram HTML parse mode. */
export function safeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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

/** Strip internal LangGraph XML routing markers that sometimes leak into replies. */
function stripXmlTags(text: string): string {
  return text
    .replace(/<name>[^<]*<\/name>/g, "")
    .replace(/<content>([\s\S]*?)<\/content>/g, "$1")
    .trim();
}

/** Pull the office's final human-readable reply (last AI message with text). */
export function finalReply(res: { messages?: OfficeMessage[] }): string {
  const msgs = res.messages ?? [];
  // Pass 1: prefer AI text message (strips internal LangGraph XML routing markers)
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    const type = m._getType?.() ?? "";
    const text = typeof m.content === "string" ? m.content : "";
    if (type === "ai" && text.trim() && !(m.tool_calls && m.tool_calls.length > 0)) {
      return stripXmlTags(text.trim());
    }
  }
  // Pass 2: fall back to last tool message so engineering/shell results surface
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    const type = m._getType?.() ?? "";
    const text = typeof m.content === "string" ? m.content : "";
    if (type === "tool" && text.trim()) {
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

/**
 * Slice only the messages added during the current invoke() turn.
 * The Postgres checkpointer returns the FULL thread trail on every call.
 * Passing everything to finalReply/collectToolErrors means stale AI answers
 * and old tool errors from prior turns keep surfacing (the "identical stale
 * reply" + "persistent toolErrors:1" bugs). Slicing from baseLen isolates
 * exactly this turn's output.
 *
 * baseLen = messages.length BEFORE invoke(); clamp both edges gracefully.
 */
export function sliceFreshMessages(
  messages: OfficeMessage[],
  baseLen: number,
): OfficeMessage[] {
  const start = Math.max(0, Math.min(baseLen, messages.length));
  return messages.slice(start);
}

// ── Thread guards ──────────────────────────────────────────────────────────────

/**
 * Detect a pending interrupt() on the thread and drain it with
 * Command({ resume: "rejected" }) — fail-safe because every HITL wrapper
 * only executes the side effect on "approved", so a rejection is a clean no-op.
 *
 * Called at the START of every new free-text message handler. If a pending
 * approval exists we cancel it, return the approval (so the gateway can inform
 * the founder), and leave the thread in a clean resumable state for the
 * subsequent fresh invoke(). Returns null if no interrupt was pending.
 *
 * This fixes the root cause: a new message invoked on a wedged thread
 * re-served the parked state forever (both finalReply and collectToolErrors
 * resurrected old content every turn).
 */
export async function resolvePendingApproval(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  office: { getState: (c: any) => Promise<unknown>; invoke: (input: any, c?: any) => Promise<unknown> },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: any,
): Promise<ApprovalRequest | null> {
  const pending = await getPendingApproval(office as Parameters<typeof getPendingApproval>[0], config);
  if (!pending) return null;
  await office.invoke(new Command({ resume: "rejected" }), config);
  return pending;
}

/**
 * Detect and clear a thread wedged mid-graph by an aborted run.
 *
 * Root cause (observed live on thread turicks:6775330211): a run that stops
 * abnormally (recursion limit, budget, crash) leaves `state.next` on a
 * half-executed node with NO interrupt. Every subsequent invoke({messages})
 * then RESUMES that stuck node instead of starting a fresh turn — the thread
 * loops to the recursion limit on every message until a manual /reset. This
 * auto-recovers by wiping the wedged checkpoint so the next message starts
 * clean.
 *
 * MUST run after resolvePendingApproval so a real HITL pause (also next-non-
 * empty) is served as an approval, not wiped as a wedge.
 *
 * @returns true if a wedge was detected and cleared.
 */
export async function recoverWedgedThread(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  office: { getState: (c: any) => Promise<unknown> },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: any,
  threadId: string,
): Promise<boolean> {
  const state = (await office.getState(config).catch(() => null)) as WedgeState | null;
  if (!isWedgedState(state)) return false;
  log.warn({ threadId, next: state?.next }, "Wedged thread detected (pending node, no interrupt) — clearing checkpoint");
  await clearThreadCheckpoints(threadId);
  return true;
}

/**
 * Best-effort wedge clear used inside catch blocks after an abort. Re-fetches
 * the office, clears the thread only if genuinely wedged, and never throws
 * (we're already handling an error — recovery must not mask it).
 */
async function clearWedgeQuietly(chatId: number | string): Promise<void> {
  try {
    const office = await getOffice();
    await recoverWedgedThread(office, officeConfig(chatId), threadIdFor(chatId));
  } catch (err) {
    log.warn({ chatId, err: (err as Error).message }, "Post-abort wedge clear failed — non-fatal");
  }
}

// ── Send helpers ─────────────────────────────────────────────────────────────

/** Send the office's result to Telegram — final reply plus any tool failures. */
async function sendResult(ctx: Context, res: { messages?: OfficeMessage[] }, chatId: number | string): Promise<void> {
  const reply = finalReply(res);
  const errs = collectToolErrors(res);

  // Convert the model's Markdown → Telegram-safe HTML so bold/bullets/code
  // render properly instead of leaking raw asterisks.
  let out = markdownToTelegramHtml(reply);
  if (errs.length > 0) {
    out += `\n\n⚠️ <b>Tool issue${errs.length > 1 ? "s" : ""}:</b>\n<code>${safeHtml(errs.join("\n").slice(0, 800))}</code>`;
  }

  // Telegram caps messages at 4096 chars — split long replies across messages.
  const chunks = splitForTelegram(out, TELEGRAM_MAX);
  for (const chunk of chunks) {
    await sendHtmlSafe(ctx, chunk);
  }

  log.info(
    { chatId, replyPreview: reply.slice(0, 80), chunks: chunks.length, toolErrors: errs.length },
    "Replied to Telegram",
  );
}

/**
 * Send an HTML message, falling back to plain text if Telegram rejects the
 * markup (e.g. a malformed tag the converter didn't catch). A formatting slip
 * must never swallow the founder's answer.
 */
async function sendHtmlSafe(ctx: Context, html: string): Promise<void> {
  try {
    await ctx.reply(html, { parse_mode: "HTML" });
  } catch (err) {
    log.warn({ err: (err as Error).message }, "HTML send failed — retrying as plain text");
    // Strip tags for a readable plain-text fallback.
    const plain = html.replace(/<[^>]+>/g, "");
    await ctx.reply(plain);
  }
}

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

// ── Office run helpers ─────────────────────────────────────────────────────────

/** Build the LangGraph config for a chat's thread (single source of construction). */
function officeConfig(chatId: number | string) {
  return {
    configurable: { thread_id: threadIdFor(chatId) },
    recursionLimit: OFFICE_RECURSION_LIMIT,
  };
}

/**
 * Start the Telegram "typing…" indicator and return a stop() closure.
 * One timer reference, no leaks — replaces the duplicated setInterval boilerplate
 * (and the function-object side-channel hack from the interrupt-guard branch).
 */
function startTyping(ctx: Context): () => void {
  ctx.replyWithChatAction("typing").catch(() => {});
  const id = setInterval(() => ctx.replyWithChatAction("typing").catch(() => {}), 4000);
  return () => clearInterval(id);
}

/**
 * Bound the persisted thread to the last N human turns. The PERMANENT fix for
 * stale-anchoring: without this, the checkpointer replays the whole history
 * forever and the model loops on old state. Fire-and-forget; never crashes the
 * handler. Guarded: never trims while an approval is pending (updateState would
 * clobber the paused interrupt).
 */
export async function trimThreadHistory(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  office: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: any,
): Promise<void> {
  const pending = await getPendingApproval(office, config);
  if (pending) return; // mid-HITL — do not touch state

  const state = await office.getState(config).catch(() => null);
  const messages: BaseMessage[] = state?.values?.messages ?? [];
  const { toRemove } = computeHistoryTrim(messages, { keepTurns: HISTORY_KEEP_TURNS });
  if (toRemove.length === 0) return;

  const removals = toRemove.map((id) => new RemoveMessage({ id }));
  await office.updateState(config, { messages: removals });
  log.debug({ removed: toRemove.length }, "Trimmed thread history to last N turns");
}

// ── Route an incoming message into the office ──────────────────────────────────

/** Route the literal text of the incoming message into the office. */
export async function routeToOffice(ctx: Context): Promise<void> {
  const text = ctx.message?.text;
  if (!text || text.trim().length === 0) {
    await ctx.reply("❌ I need text to process. Please send a message.");
    return;
  }
  await runOfficeText(ctx, text);
}

/**
 * Run an arbitrary prompt through the office on this chat's thread.
 * Shared by plain messages and commands (e.g. /outbound builds its own prompt).
 */
export async function runOfficeText(ctx: Context, text: string): Promise<void> {
  const chatId = ctx.chat?.id ?? ctx.from?.id ?? "unknown";
  const config = officeConfig(chatId);

  log.info({ chatId, task: text.slice(0, 80) }, "Routing to office");
  const stopTyping = startTyping(ctx);

  try {
    const office = await getOffice();

    // ── Interrupt guard ───────────────────────────────────────────────────────
    // If the thread is paused on a pending approval, a fresh invoke({messages})
    // re-serves the parked state and produces a stale reply every turn. Cancel it
    // first, inform the founder, then proceed with the new request.
    const stale = await resolvePendingApproval(office, config);
    if (stale) {
      log.warn({ chatId, title: stale.title }, "Cancelled stale pending approval — new message arrived");
      await ctx.reply(
        `⏸️ <b>Pending approval cancelled</b>\n` +
        `You had an unanswered approval card (<i>${safeHtml(stale.title)}</i>). ` +
        `I've cancelled it so your new request runs cleanly. Re-ask if you still want it.`,
        { parse_mode: "HTML" },
      );
    }

    // ── Wedge guard ───────────────────────────────────────────────────────────
    // A run that aborted mid-graph (recursion limit/budget/crash) leaves the
    // thread parked on a pending node with no interrupt; a fresh invoke would
    // resume the stuck node and loop forever. Clear it so this message runs clean.
    if (await recoverWedgedThread(office, config, threadIdFor(chatId))) {
      log.warn({ chatId }, "Recovered wedged thread before new message");
      await ctx.reply(
        `🧹 <b>Recovered a stuck task.</b> A previous run didn't finish cleanly, so I cleared it. ` +
        `Running your new message fresh.`,
        { parse_mode: "HTML" },
      );
    }

    // ── Capture turn boundary before invoke ───────────────────────────────────
    // The checkpointer returns the full trail after invoke. Slicing to baseLen
    // isolates this turn's output so finalReply/collectToolErrors never surface
    // messages from earlier turns.
    const beforeState = await office.getState(config).catch((err) => {
      log.warn({ chatId, err: (err as Error).message }, "getState failed — baseLen will be 0 (reply may include stale content)");
      return null;
    }) as { values?: { messages?: OfficeMessage[] } } | null;
    const baseLen = (beforeState?.values?.messages ?? []).length;

    const budget = createRunBudget();
    const agentModel = process.env["AGENT_MODEL"] ?? "gemini-2.5-flash";

    // Inject a deterministic pre-router hint so the supervisor starts in the
    // right department. Same builder the eval uses (CLAUDE.md rule #19).
    const invokeMessages: BaseMessage[] = buildOfficeInput(text);

    // Guard: Gemini returns 400 if contents is empty or last message is blank.
    assertNonEmptyMessages(invokeMessages, "runOfficeText");

    const res = (await office.invoke(
      { messages: invokeMessages },
      { ...config, callbacks: [new BudgetGuardCallback(budget, agentModel)] },
    )) as { messages?: OfficeMessage[] };
    stopTyping();

    log.debug({ chatId, ...budget.summary }, "Run complete — budget summary");

    const approval = await getPendingApproval(office, config);
    if (approval) {
      await sendApprovalCard(ctx, approval);
      return;
    }

    // Slice to current turn — prevents stale reply / phantom tool error
    const freshMessages = sliceFreshMessages(res.messages ?? [], baseLen);
    const freshRes = { messages: freshMessages.length > 0 ? freshMessages : res.messages };
    await sendResult(ctx, freshRes, chatId);
    // Clean turn → record episodic memory + bound the persisted history so the
    // thread can never grow unbounded and anchor the model on stale state.
    if (freshMessages.length > 0) {
      recordConversationEnd(threadIdFor(chatId), res.messages ?? []).catch((err) =>
        log.warn({ chatId, err: (err as Error).message }, "Conversation recording failed"),
      );
      trimThreadHistory(office, config).catch((err) =>
        log.warn({ chatId, err: (err as Error).message }, "History trim failed — non-fatal"),
      );
    }
  } catch (err) {
    stopTyping();
    if (err instanceof BudgetExceededError) {
      log.warn({ chatId, reason: err.reason }, "Run stopped: budget exceeded");
      await clearWedgeQuietly(chatId);
      await ctx.reply(
        `💰 <b>Run stopped — budget limit reached</b>\n` +
          `<code>${safeHtml(err.reason)}</code>\n\n` +
          `Adjust <code>RUN_BUDGET_USD</code> or <code>RUN_BUDGET_TOKENS</code> in <code>.env</code> to raise the cap.`,
        { parse_mode: "HTML" },
      );
      return;
    }
    if (err instanceof GraphRecursionError) {
      log.warn({ chatId }, "Run stopped: recursion limit reached");
      // Preventive: the aborted run left the thread parked on a pending node.
      // Clear it now so the founder's NEXT message isn't trapped in the same loop.
      await clearWedgeQuietly(chatId);
      await ctx.reply(
        `🔁 <b>I got stuck in a loop on that one</b> and stopped to avoid runaway cost.\n` +
          `I've cleared that task — just send your next message normally.`,
        { parse_mode: "HTML" },
      );
      return;
    }
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    log.error({ err: msg, chatId }, "Office run failed");
    await ctx.reply(`❌ <b>Error</b>\n<code>${safeHtml(msg.slice(0, 1200))}</code>`, {
      parse_mode: "HTML",
    });
  }
}

// ── Resume a paused run after an approval decision ─────────────────────────────

export async function resumeOffice(ctx: Context, decision: "approved" | "rejected"): Promise<void> {
  const chatId = ctx.chat?.id ?? ctx.from?.id ?? "unknown";
  const config = officeConfig(chatId);

  try {
    const office = await getOffice();

    // Idempotency — don't re-invoke if no interrupt exists (double-tap, restart).
    const pending = await getPendingApproval(office, config);
    if (!pending) {
      await ctx.reply("ℹ️ No pending approval found — it may have already been handled.", { parse_mode: "HTML" });
      return;
    }

    // Capture turn boundary so the resume reply only shows this turn's output
    // (otherwise collectToolErrors re-surfaces every prior turn's tool errors).
    const beforeState = await office.getState(config).catch(() => null) as { values?: { messages?: OfficeMessage[] } } | null;
    const baseLen = (beforeState?.values?.messages ?? []).length;

    // Guard: validate checkpoint messages before resuming to prevent Gemini 400
    // "contents is not specified" when history trim leaves blank/empty messages.
    const checkpointMessages = (beforeState?.values?.messages ?? []) as BaseMessage[];
    try {
      assertNonEmptyMessages(checkpointMessages, "resumeOffice");
    } catch (guardErr) {
      log.error({ chatId, err: (guardErr as Error).message }, "resumeOffice guard: checkpoint invalid — aborting to prevent Gemini 400");
      await ctx.reply(
        `❌ <b>Cannot resume — conversation state is invalid.</b>\n\nUse /reset to clear the thread and try again.`,
        { parse_mode: "HTML" },
      );
      return;
    }

    const budget = createRunBudget();
    const agentModel = process.env["AGENT_MODEL"] ?? "gemini-2.5-flash";
    const res = (await office.invoke(
      new Command({ resume: decision }),
      { ...config, callbacks: [new BudgetGuardCallback(budget, agentModel)] },
    )) as { messages?: OfficeMessage[] };

    // A run may pause again (e.g. research → then email approval).
    const next = await getPendingApproval(office, config);
    if (next) {
      await sendApprovalCard(ctx, next);
      return;
    }
    const freshMessages = sliceFreshMessages(res.messages ?? [], baseLen);
    const freshRes = { messages: freshMessages.length > 0 ? freshMessages : res.messages };
    await sendResult(ctx, freshRes, chatId);
    trimThreadHistory(office, config).catch((err) =>
      log.warn({ chatId, err: (err as Error).message }, "History trim failed — non-fatal"),
    );
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      log.warn({ chatId, reason: err.reason }, "Resume stopped: budget exceeded");
      await clearWedgeQuietly(chatId);
      await ctx.reply(`💰 <b>Run stopped — budget limit reached</b>\n<code>${safeHtml(err.reason)}</code>`, { parse_mode: "HTML" });
      return;
    }
    if (err instanceof GraphRecursionError) {
      log.warn({ chatId }, "Resume stopped: recursion limit reached");
      await clearWedgeQuietly(chatId);
      await ctx.reply(`🔁 <b>That got stuck in a loop</b> and I stopped it. I've cleared that task — send your next message normally.`, { parse_mode: "HTML" });
      return;
    }
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    log.error({ err: msg, chatId }, "Office resume failed");
    await ctx.reply(`❌ <b>Resume failed</b>\n<code>${safeHtml(msg.slice(0, 1200))}</code>`, {
      parse_mode: "HTML",
    });
  }
}
