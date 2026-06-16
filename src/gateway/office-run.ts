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
import { RemoveMessage, SystemMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { TENANT, OFFICE_RECURSION_LIMIT, HISTORY_KEEP_TURNS } from "../core/config.js";
import { computeHistoryTrim } from "../infra/history-window.js";
import { logger } from "../infra/logger.js";
import { getOffice, getPendingApproval } from "../agents/office.js";
import type { ApprovalRequest } from "../agents/agent-tools.js";
import { clearThreadCheckpoints } from "../infra/checkpointer.js";
import { cancelPendingApprovals, getPendingInterrupt, resolveInterrupt } from "../db/queries.js";
import { markdownToTelegramHtml, splitForTelegram, TELEGRAM_MAX } from "./format.js";
import { buildOfficeInput } from "./pre-router.js";
import {
  detectLinkedInRefusalWithoutTool,
  detectUnbackedShellClaim,
} from "./execution-guard.js";
import { assertNonEmptyMessages } from "../infra/office-guard.js";
import { isWedgedState, type WedgeState } from "../infra/wedge.js";
import { BudgetExceededError, BudgetGuardCallback, createRunBudget } from "../infra/budget.js";
import { recordConversationEnd } from "../infra/conversation-recorder.js";
import { startTurn, activePromptHash, type TurnTrace } from "../infra/trace.js";
import { readHalt, formatHaltNotice } from "../infra/halt.js";
import { TraceCallback } from "../infra/trace-callback.js";
import { buildRunMetadata } from "../infra/telemetry.js";
import { SUPERVISOR_PROMPT } from "../agents/system-prompts.js";

const log = logger.child({ module: "office-run" });

/** Only re-post HITL cards paused within this window (crash recovery, not ancient E2E junk). */
export const HITL_RESTORE_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/** Serialize office runs per chat so slow turns cannot bleed replies into the next message. */
const chatTurnChains = new Map<string, Promise<void>>();

export async function withChatTurnLock<T>(chatId: string | number, fn: () => Promise<T>): Promise<T> {
  const key = String(chatId);
  const tail = chatTurnChains.get(key) ?? Promise.resolve();
  let release!: () => void;
  const slot = new Promise<void>((resolve) => {
    release = resolve;
  });
  chatTurnChains.set(key, tail.then(() => slot));
  await tail;
  try {
    return await fn();
  } finally {
    release();
    if (chatTurnChains.get(key) === slot) chatTurnChains.delete(key);
  }
}

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
    .replace(/<\/?(name|content)>/g, "") // orphaned tags not caught by pair-matcher
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
 *
 * Bug fix (F1, 2026-06-12): the keyword scan ran over the WHOLE result body, so a
 * SUCCESSFUL multi-line result that merely mentioned an error word deep inside
 * (e.g. read_context returning founder notes, or a research summary discussing
 * "startups that fail") was falsely surfaced as a "⚠️ Tool issue" with a raw dump
 * appended to the reply. Real tool errors are signalled two ways and only two:
 *   1. a structured failure flag — `{ success|ok: false }` (how tools soft-fail), or
 *   2. an error keyword on the FIRST LINE (errors lead their message; content
 *      bodies do not). Deep-body matches are content, not failures.
 */
const TOOL_ERROR_KEYWORDS =
  /(fail|error|not set|not configured|cannot find|blocked|unauthor|invalid|denied)/i;
const STRUCTURED_FAILURE = /"(?:success|ok)"\s*:\s*false/i;

export function isToolFailure(content: string): boolean {
  if (STRUCTURED_FAILURE.test(content)) return true;
  const firstLine = content.split("\n", 1)[0] ?? "";
  return TOOL_ERROR_KEYWORDS.test(firstLine);
}

export function collectToolErrors(res: { messages?: OfficeMessage[] }): string[] {
  const errs: string[] = [];
  for (const m of res.messages ?? []) {
    if ((m._getType?.() ?? "") !== "tool") continue;
    const c = typeof m.content === "string" ? m.content : "";
    if (isToolFailure(c)) {
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
  const threadId = config?.configurable?.thread_id as string | undefined;
  if (threadId) {
    const row = await getPendingInterrupt(threadId);
    if (row) await resolveInterrupt(row.interrupt_id, "rejected");
  }
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
 * Unconditionally clear a thread's checkpoint after an IN-PROCESS abort
 * (recursion limit / budget exceeded). Mirrors what /reset does, and never throws
 * (we're already handling an error — recovery must not mask it).
 *
 * Root cause this fixes (P0): the abort catch blocks used to clear via the
 * isWedgedState()-gated guard (recoverWedgedThread). But a recursion abort
 * frequently leaves a snapshot whose `next` is empty — the pending *writes* in
 * checkpoint_writes are what resume-loop, not the snapshot's `next` — so the gate
 * returned false and the checkpoint survived. The next invoke({messages}) then
 * resumed the stuck writes and instantly re-hit the limit ("🔁 stuck" on every
 * message until a manual /reset; one bad task bricked the chat).
 *
 * Here we KNOW the run died mid-graph, so gating is wrong: an abort is never a
 * legitimate HITL pause. Clear unconditionally and deterministically.
 */
async function clearThreadAfterAbort(chatId: number | string): Promise<void> {
  try {
    await clearThreadCheckpoints(threadIdFor(chatId));
  } catch (err) {
    log.warn({ chatId, err: (err as Error).message }, "Post-abort checkpoint clear failed — non-fatal");
  }
  await cancelGhostApprovals(chatId);
}

/**
 * Best-effort: cancel any still-pending HITL approval rows for an abandoned
 * thread (G9). The interrupt itself lives in the checkpointer (just cleared);
 * the hitl_approvals row is a side table the daily stale-reminder reads, so a
 * leftover "pending" row becomes a ghost the cron nags about forever. Never
 * throws — a failed cleanup must not break the reject/abort path.
 */
async function cancelGhostApprovals(chatId: number | string): Promise<void> {
  try {
    const cancelled = await cancelPendingApprovals(threadIdFor(chatId));
    if (cancelled > 0) {
      log.info({ chatId, cancelled }, "Cancelled ghost HITL approval(s) for abandoned thread");
    }
  } catch (err) {
    log.warn({ chatId, err: (err as Error).message }, "Cancel ghost approvals failed — non-fatal");
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

/** Build the HTML body + inline keyboard for an approval card (shared by reply + restart repost). */
export function formatApprovalCard(
  approval: ApprovalRequest,
  opts: { afterRestart?: boolean } = {},
): { html: string; keyboard: InlineKeyboard } {
  const keyboard = new InlineKeyboard()
    .text("✅ Approve", "approve")
    .text("❌ Reject", "reject");
  const preview = approval.preview ? `\n\n<i>${safeHtml(approval.preview.slice(0, 1500))}</i>` : "";
  const prefix = opts.afterRestart
    ? `⏸️ <b>Resuming after restart</b> — still waiting on your approval:\n\n`
    : "";
  return {
    html: `${prefix}${safeHtml(approval.title)}\n${safeHtml(approval.summary)}${preview}`,
    keyboard,
  };
}

async function sendApprovalCard(ctx: Context, approval: ApprovalRequest): Promise<void> {
  const { html, keyboard } = formatApprovalCard(approval);
  await ctx.reply(html, { parse_mode: "HTML", reply_markup: keyboard });
}

/**
 * After a process restart, Telegram inline buttons on the OLD card are dead but the
 * LangGraph checkpoint may still hold the interrupt. Re-post a fresh card only for
 * recent pauses; auto-clear ancient E2E leftovers (git clone cards, etc.).
 */
export async function clearStalePendingInterruptOnBoot(chatId: string | number): Promise<boolean> {
  const office = await getOffice();
  const config = officeConfig(chatId);
  const threadId = threadIdFor(chatId);
  const pending = await getPendingApproval(office, config);
  if (!pending) return false;

  const dbRow = await getPendingInterrupt(threadId);
  if (!dbRow) {
    await office.invoke(new Command({ resume: "rejected" }), config);
    await cancelPendingApprovals(threadId);
    log.info({ chatId, title: pending.title }, "Cleared orphan HITL interrupt on boot (no DB row)");
    return true;
  }

  const dbAt = dbRow.created_at ? new Date(dbRow.created_at).getTime() : 0;
  const expired = dbRow.expires_at < new Date();
  const tooOld = dbAt > 0 && Date.now() - dbAt > HITL_RESTORE_MAX_AGE_MS;

  if (!expired && !tooOld) return false;

  if (dbRow) await resolveInterrupt(dbRow.interrupt_id, "expired");
  await office.invoke(new Command({ resume: "rejected" }), config);
  await cancelPendingApprovals(threadId);
  log.info({ chatId, title: pending.title, tooOld, expired }, "Cleared stale HITL interrupt on boot");
  return true;
}

export async function restorePendingApprovalAfterRestart(chatId: string | number): Promise<boolean> {
  if (await clearStalePendingInterruptOnBoot(chatId)) return false;

  const office = await getOffice();
  const config = officeConfig(chatId);
  const pending = await getPendingApproval(office, config);
  if (!pending) return false;

  const { html, keyboard } = formatApprovalCard(pending, { afterRestart: true });
  const { getBot } = await import("./telegram.js");
  await getBot().api.sendMessage(chatId, html, { parse_mode: "HTML", reply_markup: keyboard });
  log.info({ chatId, title: pending.title }, "Re-posted pending HITL card after restart");
  return true;
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
  trace?: TurnTrace,
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
  trace?.event("checkpoint.trim", { removed: toRemove.length });
}

// ── Route an incoming message into the office ──────────────────────────────────

function needsExecutionGuardRetry(
  userText: string,
  messages: OfficeMessage[],
  reply: string,
): "shell" | "linkedin" | null {
  if (detectUnbackedShellClaim(userText, messages, reply)) return "shell";
  if (detectLinkedInRefusalWithoutTool(userText, messages, reply)) return "linkedin";
  return null;
}

function buildGuardRetryMessages(kind: "shell" | "linkedin", userText: string): BaseMessage[] {
  if (kind === "shell") {
    return [
      new SystemMessage(
        "[RETRY DIRECTIVE: Your previous reply falsely claimed a shell command ran. " +
          "Call run_shell NOW with the exact command. Do NOT claim execution without an approval card.]",
      ),
      new HumanMessage(userText),
    ];
  }
  return [
    new SystemMessage(
      "[RETRY DIRECTIVE: Never refuse LinkedIn posts for banned phrases. " +
        "Write the post, call linkedin_post — the tool auto-strips banned phrases before the approval card.]",
    ),
    new HumanMessage(userText),
  ];
}

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
  await withChatTurnLock(chatId, () => runOfficeTextLocked(ctx, text, chatId));
}

async function runOfficeTextLocked(ctx: Context, text: string, chatId: number | string): Promise<void> {
  const config = officeConfig(chatId);

  const trace = startTurn({ chatId, kind: "message", promptHash: activePromptHash(SUPERVISOR_PROMPT) });
  trace.event("turn.in", { textLen: text.length });

  // ── Global halt (kill switch) ───────────────────────────────────────────────
  // A founder-engaged halt (/halt) refuses every NEW turn before any office work
  // or side effect. Checked at turn entry; an in-flight run is not aborted (turns
  // are seconds-long and the budget guard caps runaway loops). See docs/PRODUCTION.md.
  const halt = await readHalt();
  if (halt) {
    trace.event("halt.blocked", { reason: halt.reason });
    log.warn({ chatId, reason: halt.reason }, "Turn refused — global halt engaged");
    await ctx.reply(formatHaltNotice(halt), { parse_mode: "HTML" });
    return;
  }

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
      trace.event("hitl.interrupt", { cancelledStale: true, title: stale.title });
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
      trace.event("wedge.recovered", {});
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
    trace.event("route.decided", { hint: (invokeMessages[0]?.content ?? "").toString().slice(0, 60) });

    // Guard: Gemini returns 400 if contents is empty or last message is blank.
    assertNonEmptyMessages(invokeMessages, "runOfficeText");

    const res = (await office.invoke(
      { messages: invokeMessages },
      {
        ...config,
        callbacks: [new BudgetGuardCallback(budget, agentModel), new TraceCallback(trace)],
        metadata: buildRunMetadata({ tenant_id: TENANT, trace_id: trace.turnId, prompt_hash: trace.promptHash }),
      },
    )) as { messages?: OfficeMessage[] };
    stopTyping();

    log.debug({ chatId, ...budget.summary }, "Run complete — budget summary");

    let approval = await getPendingApproval(office, config);
    if (approval) {
      trace.event("hitl.interrupt", { title: approval.title });
      await sendApprovalCard(ctx, approval);
      return;
    }

    // Slice to current turn — prevents stale reply / phantom tool error
    let freshMessages = sliceFreshMessages(res.messages ?? [], baseLen);
    let freshRes = { messages: freshMessages.length > 0 ? freshMessages : res.messages };

    const guardKind = needsExecutionGuardRetry(text, freshRes.messages ?? [], finalReply(freshRes));
    if (guardKind) {
      trace.event("guard.retry", { kind: guardKind });
      log.warn({ chatId, kind: guardKind }, "Execution guard retry — model skipped gated tool");
      const retryMessages = buildGuardRetryMessages(guardKind, text);
      assertNonEmptyMessages(retryMessages, "executionGuardRetry");
      const retryBefore = (await office.getState(config).catch(() => null)) as {
        values?: { messages?: OfficeMessage[] };
      } | null;
      const retryBaseLen = (retryBefore?.values?.messages ?? []).length;
      const retryRes = (await office.invoke(
        { messages: retryMessages },
        {
          ...config,
          callbacks: [new BudgetGuardCallback(budget, agentModel), new TraceCallback(trace)],
          metadata: buildRunMetadata({ tenant_id: TENANT, trace_id: trace.turnId, prompt_hash: trace.promptHash }),
        },
      )) as { messages?: OfficeMessage[] };
      approval = await getPendingApproval(office, config);
      if (approval) {
        trace.event("hitl.interrupt", { title: approval.title, guardRetry: guardKind });
        await sendApprovalCard(ctx, approval);
        return;
      }
      freshMessages = sliceFreshMessages(retryRes.messages ?? [], retryBaseLen);
      freshRes = { messages: freshMessages.length > 0 ? freshMessages : retryRes.messages };
    }

    await sendResult(ctx, freshRes, chatId);
    trace.event("turn.out", {
      toolErrors: collectToolErrors(freshRes).length,
      inputTokens: budget.summary.totalInputTokens,
      outputTokens: budget.summary.totalOutputTokens,
      usd: Number(budget.summary.totalUsd.toFixed(6)),
    });
    // Clean turn → record episodic memory + bound the persisted history so the
    // thread can never grow unbounded and anchor the model on stale state.
    if (freshMessages.length > 0) {
      recordConversationEnd(threadIdFor(chatId), res.messages ?? []).catch((err) =>
        log.warn({ chatId, err: (err as Error).message }, "Conversation recording failed"),
      );
      trimThreadHistory(office, config, trace).catch((err) =>
        log.warn({ chatId, err: (err as Error).message }, "History trim failed — non-fatal"),
      );
    }
  } catch (err) {
    stopTyping();
    trace.event("turn.error", { kind: err instanceof Error ? err.name : "unknown" });
    if (err instanceof BudgetExceededError) {
      log.warn({ chatId, reason: err.reason }, "Run stopped: budget exceeded");
      await clearThreadAfterAbort(chatId);
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
      await clearThreadAfterAbort(chatId);
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

/**
 * Plain-text confirmation shown to the founder when they reject an approval.
 * Pure (no I/O) so the reject behaviour is unit-testable without grammy/office.
 */
export function buildRejectionConfirmation(approval: ApprovalRequest): string {
  // Strip the trailing "?" from the card title ("Send email to X?") so the
  // confirmation reads as a statement.
  const what = approval.title.replace(/^[^\w]*/, "").replace(/\?+\s*$/, "").trim();
  return `❌ <b>Cancelled.</b> I won't proceed with: <i>${safeHtml(what)}</i>\nNothing was sent. Re-ask if you change your mind.`;
}

export async function resumeOffice(ctx: Context, decision: "approved" | "rejected"): Promise<void> {
  const chatId = ctx.chat?.id ?? ctx.from?.id ?? "unknown";
  await withChatTurnLock(chatId, () => resumeOfficeLocked(ctx, decision, chatId));
}

async function resumeOfficeLocked(ctx: Context, decision: "approved" | "rejected", chatId: number | string): Promise<void> {
  const config = officeConfig(chatId);
  const trace = startTurn({ chatId, kind: "resume", promptHash: activePromptHash(SUPERVISOR_PROMPT) });
  trace.event("hitl.resume", { decision });

  // ── Global halt (kill switch) ───────────────────────────────────────────────
  // Freeze approvals too: while halted we never resume into the office, so no
  // side effect (email/LinkedIn/GitHub/file write) executes. The pending card
  // stays put until /resume — fail-safe by default. See docs/PRODUCTION.md.
  const halt = await readHalt();
  if (halt) {
    trace.event("halt.blocked", { reason: halt.reason, decision });
    log.warn({ chatId, reason: halt.reason, decision }, "Resume refused — global halt engaged");
    await ctx.reply(formatHaltNotice(halt), { parse_mode: "HTML" });
    return;
  }

  try {
    const office = await getOffice();

    // Idempotency — don't re-invoke if no interrupt exists (double-tap, restart).
    const pending = await getPendingApproval(office, config);
    if (!pending) {
      await ctx.reply("ℹ️ No pending approval found — it may have already been handled.", { parse_mode: "HTML" });
      return;
    }

    // ── Rejection terminates the turn — NEVER resume into the agent ────────────
    // A ReAct sub-agent treats the rejection tool-result ("❌ Rejected by
    // founder.") as feedback and re-drafts, firing interrupt() again → an
    // endless stream of approval cards the founder can't escape (live repro
    // 2026-06-12). The founder said no, so we abandon the paused task
    // deterministically: clear the thread and confirm. The side effect only
    // runs after an "approved" resume, so action_log stays empty (safety holds).
    if (decision === "rejected") {
      const row = await getPendingInterrupt(threadIdFor(chatId));
      if (row) await resolveInterrupt(row.interrupt_id, "rejected");
      await clearThreadCheckpoints(threadIdFor(chatId));
      await cancelGhostApprovals(chatId);
      trace.event("turn.out", { rejected: true });
      await ctx.reply(buildRejectionConfirmation(pending), { parse_mode: "HTML" });
      log.info({ chatId, action: pending.action }, "Founder rejected — task cancelled, thread cleared (no re-draft)");
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
      {
        ...config,
        callbacks: [new BudgetGuardCallback(budget, agentModel), new TraceCallback(trace)],
        metadata: buildRunMetadata({ tenant_id: TENANT, trace_id: trace.turnId, prompt_hash: trace.promptHash }),
      },
    )) as { messages?: OfficeMessage[] };

    // A run may pause again (e.g. research → then email approval).
    const next = await getPendingApproval(office, config);
    if (next) {
      trace.event("hitl.interrupt", { title: next.title, rePaused: true });
      await sendApprovalCard(ctx, next);
      return;
    }
    const row = await getPendingInterrupt(threadIdFor(chatId));
    if (row) await resolveInterrupt(row.interrupt_id, "approved");
    const freshMessages = sliceFreshMessages(res.messages ?? [], baseLen);
    const freshRes = { messages: freshMessages.length > 0 ? freshMessages : res.messages };
    await sendResult(ctx, freshRes, chatId);
    trace.event("turn.out", {
      resumed: true,
      inputTokens: budget.summary.totalInputTokens,
      outputTokens: budget.summary.totalOutputTokens,
      usd: Number(budget.summary.totalUsd.toFixed(6)),
    });
    trimThreadHistory(office, config, trace).catch((err) =>
      log.warn({ chatId, err: (err as Error).message }, "History trim failed — non-fatal"),
    );
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      log.warn({ chatId, reason: err.reason }, "Resume stopped: budget exceeded");
      await clearThreadAfterAbort(chatId);
      await ctx.reply(`💰 <b>Run stopped — budget limit reached</b>\n<code>${safeHtml(err.reason)}</code>`, { parse_mode: "HTML" });
      return;
    }
    if (err instanceof GraphRecursionError) {
      log.warn({ chatId }, "Resume stopped: recursion limit reached");
      await clearThreadAfterAbort(chatId);
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
