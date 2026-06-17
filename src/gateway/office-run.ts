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

import { type Context } from "grammy";
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
  detectUnbackedInboxClaim,
  detectUnbackedShellClaim,
} from "./execution-guard.js";
import { tryInboxReadFastPath } from "./inbox-fast-path.js";
import { assertNonEmptyMessages } from "../infra/office-guard.js";
import { isWedgedState, type WedgeState } from "../infra/wedge.js";
import { BudgetExceededError, BudgetGuardCallback, createRunBudget } from "../infra/budget.js";
import { recordConversationEnd } from "../infra/conversation-recorder.js";
import { startTurn, activePromptHash, type TurnTrace } from "../infra/trace.js";
import { readHalt, formatHaltNotice } from "../infra/halt.js";
import { TraceCallback } from "../infra/trace-callback.js";
import { buildRunMetadata } from "../infra/telemetry.js";
import { SUPERVISOR_PROMPT } from "../agents/system-prompts.js";
import { safeHtml, formatApprovalCard } from "./approval-card.js";
import { createTelegramSession, type GatewaySession } from "./session.js";
import { syncMissionTrace, refreshMissionDashboard } from "./mission-sync.js";

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

// ── Safe HTML (re-export for backwards compatibility) ─────────────────────────

export { safeHtml, formatApprovalCard } from "./approval-card.js";

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

/** Send the office's result — final reply plus any tool failures. */
async function sendResult(session: GatewaySession, res: { messages?: OfficeMessage[] }, chatId: number | string): Promise<void> {
  const reply = finalReply(res);
  const errs = collectToolErrors(res);

  let out = markdownToTelegramHtml(reply);
  if (errs.length > 0) {
    out += `\n\n⚠️ <b>Tool issue${errs.length > 1 ? "s" : ""}:</b>\n<code>${safeHtml(errs.join("\n").slice(0, 800))}</code>`;
  }

  if (session.transport === "telegram") {
    const chunks = splitForTelegram(out, TELEGRAM_MAX);
    for (const chunk of chunks) {
      await session.onHtml(chunk);
    }
    log.info(
      { chatId, replyPreview: reply.slice(0, 80), chunks: chunks.length, toolErrors: errs.length },
      "Replied to Telegram",
    );
  } else {
    await session.onReply(reply);
    if (errs.length > 0) {
      await session.onStatus(`Tool issues: ${errs.join("; ").slice(0, 500)}`);
    }
    session.emitStream("turn.complete", { replyPreview: reply.slice(0, 200), toolErrors: errs.length });
  }
}

async function sendApprovalCard(session: GatewaySession, approval: ApprovalRequest): Promise<void> {
  await session.onApproval(approval);
}

function wrapTrace(session: GatewaySession, trace: TurnTrace): TurnTrace {
  return {
    ...trace,
    event(seam, data) {
      trace.event(seam, data);
      session.emitStream(
        seam === "hitl.interrupt" ? "hitl.pending" :
        seam === "route.decided" ? "department.routed" :
        seam === "tool.call" ? "tool.start" :
        seam === "tool.result" ? "tool.end" :
        seam === "turn.out" ? "turn.complete" :
        seam === "turn.error" ? "turn.error" : "tool.start",
        data,
      );
      void syncMissionTrace(session.id, trace, seam, data);
    },
  };
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

/** Build the LangGraph config for a session thread. */
function officeConfigForSession(session: GatewaySession) {
  return {
    configurable: { thread_id: session.threadId },
    recursionLimit: OFFICE_RECURSION_LIMIT,
  };
}

/** @deprecated use officeConfigForSession — kept for boot recovery helpers. */
function officeConfig(chatId: number | string) {
  return {
    configurable: { thread_id: threadIdFor(chatId) },
    recursionLimit: OFFICE_RECURSION_LIMIT,
  };
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
): "shell" | "linkedin" | "inbox" | null {
  if (detectUnbackedShellClaim(userText, messages, reply)) return "shell";
  if (detectLinkedInRefusalWithoutTool(userText, messages, reply)) return "linkedin";
  if (detectUnbackedInboxClaim(userText, messages, reply)) return "inbox";
  return null;
}

function buildGuardRetryMessages(
  kind: "shell" | "linkedin" | "inbox",
  userText: string,
): BaseMessage[] {
  if (kind === "shell") {
    return [
      new SystemMessage(
        "[RETRY DIRECTIVE: Your previous reply falsely claimed a shell command ran. " +
          "Call run_shell NOW with the exact command. Do NOT claim execution without an approval card.]",
      ),
      new HumanMessage(userText),
    ];
  }
  if (kind === "inbox") {
    const query = /\bunread\b/i.test(userText) ? "is:unread" : "in:inbox";
    return [
      new SystemMessage(
        `[RETRY DIRECTIVE: Your previous reply summarized the inbox without calling read_emails. ` +
          `Call read_emails NOW with query "${query}" and return sender + subject lines verbatim.]`,
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

/** Run an arbitrary prompt through the office on this session's thread. */
export async function runOfficeText(ctx: Context, text: string): Promise<void> {
  const session = createTelegramSession(ctx);
  await withChatTurnLock(session.id, () => runOfficeSession(session, text));
}

/** Transport-neutral office run (Telegram + web gateways). */
export async function runOfficeSession(session: GatewaySession, text: string): Promise<void> {
  await runOfficeSessionLocked(session, text);
}

async function runOfficeSessionLocked(session: GatewaySession, text: string): Promise<void> {
  const config = officeConfigForSession(session);
  const chatId = session.id;

  const baseTrace = startTurn({ chatId, kind: "message", promptHash: activePromptHash(SUPERVISOR_PROMPT) });
  const trace = wrapTrace(session, baseTrace);
  trace.event("turn.in", { textLen: text.length });

  const halt = await readHalt();
  if (halt) {
    trace.event("halt.blocked", { reason: halt.reason });
    log.warn({ chatId, reason: halt.reason }, "Turn refused — global halt engaged");
    await session.onSystemNotice(formatHaltNotice(halt));
    return;
  }

  log.info({ chatId, task: text.slice(0, 80) }, "Routing to office");
  const stopTyping = session.onTyping();

  try {
    const office = await getOffice();

    const stale = await resolvePendingApproval(office, config);
    if (stale) {
      trace.event("hitl.interrupt", { cancelledStale: true, title: stale.title });
      log.warn({ chatId, title: stale.title }, "Cancelled stale pending approval — new message arrived");
      await session.onSystemNotice(
        `⏸️ <b>Pending approval cancelled</b>\n` +
        `You had an unanswered approval card (<i>${safeHtml(stale.title)}</i>). ` +
        `I've cancelled it so your new request runs cleanly. Re-ask if you still want it.`,
      );
    }

    if (await recoverWedgedThread(office, config, session.threadId)) {
      trace.event("wedge.recovered", {});
      log.warn({ chatId }, "Recovered wedged thread before new message");
      await session.onSystemNotice(
        `🧹 <b>Recovered a stuck task.</b> A previous run didn't finish cleanly, so I cleared it. ` +
        `Running your new message fresh.`,
      );
    }

    const inboxFast = await tryInboxReadFastPath(text);
    if (inboxFast) {
      stopTyping();
      trace.event("inbox.fastpath", { textLen: text.length });
      log.info({ chatId }, "Inbox read via fast path");
      if (session.transport === "telegram") {
        for (const chunk of splitForTelegram(markdownToTelegramHtml(inboxFast))) {
          await session.onHtml(chunk);
        }
      } else {
        await session.onReply(inboxFast);
      }
      return;
    }

    const beforeState = await office.getState(config).catch((err) => {
      log.warn({ chatId, err: (err as Error).message }, "getState failed — baseLen will be 0");
      return null;
    }) as { values?: { messages?: OfficeMessage[] } } | null;
    const baseLen = (beforeState?.values?.messages ?? []).length;

    const budget = createRunBudget();
    const agentModel = process.env["AGENT_MODEL"] ?? "gemini-2.5-flash";

    const invokeMessages: BaseMessage[] = buildOfficeInput(text);
    trace.event("route.decided", { hint: (invokeMessages[0]?.content ?? "").toString().slice(0, 60) });

    assertNonEmptyMessages(invokeMessages, "runOfficeSession");

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
      await sendApprovalCard(session, approval);
      return;
    }

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
        await sendApprovalCard(session, approval);
        return;
      }
      freshMessages = sliceFreshMessages(retryRes.messages ?? [], retryBaseLen);
      freshRes = { messages: freshMessages.length > 0 ? freshMessages : retryRes.messages };
    }

    await sendResult(session, freshRes, chatId);
    trace.event("turn.out", {
      toolErrors: collectToolErrors(freshRes).length,
      inputTokens: budget.summary.totalInputTokens,
      outputTokens: budget.summary.totalOutputTokens,
      usd: Number(budget.summary.totalUsd.toFixed(6)),
    });
    if (freshMessages.length > 0) {
      recordConversationEnd(session.threadId, res.messages ?? []).catch((err) =>
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
      await session.onSystemNotice(
        `💰 <b>Run stopped — budget limit reached</b>\n` +
          `<code>${safeHtml(err.reason)}</code>\n\n` +
          `Adjust <code>RUN_BUDGET_USD</code> or <code>RUN_BUDGET_TOKENS</code> in <code>.env</code> to raise the cap.`,
      );
      return;
    }
    if (err instanceof GraphRecursionError) {
      log.warn({ chatId }, "Run stopped: recursion limit reached");
      await clearThreadAfterAbort(chatId);
      await session.onSystemNotice(
        `🔁 <b>I got stuck in a loop on that one</b> and stopped to avoid runaway cost.\n` +
          `I've cleared that task — just send your next message normally.`,
      );
      return;
    }
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    log.error({ err: msg, chatId }, "Office run failed");
    await session.onSystemNotice(`❌ <b>Error</b>\n<code>${safeHtml(msg.slice(0, 1200))}</code>`);
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
  const session = createTelegramSession(ctx);
  await withChatTurnLock(session.id, () => resumeOfficeSession(session, decision));
}

/** Transport-neutral HITL resume. */
export async function resumeOfficeSession(
  session: GatewaySession,
  decision: "approved" | "rejected",
): Promise<void> {
  await resumeOfficeSessionLocked(session, decision);
}

async function resumeOfficeSessionLocked(
  session: GatewaySession,
  decision: "approved" | "rejected",
): Promise<void> {
  const config = officeConfigForSession(session);
  const chatId = session.id;
  const baseTrace = startTurn({ chatId, kind: "resume", promptHash: activePromptHash(SUPERVISOR_PROMPT) });
  const trace = wrapTrace(session, baseTrace);
  trace.event("hitl.resume", { decision });

  const halt = await readHalt();
  if (halt) {
    trace.event("halt.blocked", { reason: halt.reason, decision });
    log.warn({ chatId, reason: halt.reason, decision }, "Resume refused — global halt engaged");
    await session.onSystemNotice(formatHaltNotice(halt));
    return;
  }

  try {
    const office = await getOffice();

    const pending = await getPendingApproval(office, config);
    if (!pending) {
      await session.onSystemNotice("ℹ️ No pending approval found — it may have already been handled.");
      return;
    }

    if (decision === "rejected") {
      const row = await getPendingInterrupt(session.threadId);
      if (row) await resolveInterrupt(row.interrupt_id, "rejected");
      await clearThreadCheckpoints(session.threadId);
      await cancelGhostApprovals(chatId);
      trace.event("turn.out", { rejected: true });
      await session.onSystemNotice(buildRejectionConfirmation(pending));
      log.info({ chatId, action: pending.action }, "Founder rejected — task cancelled, thread cleared (no re-draft)");
      return;
    }

    const beforeState = await office.getState(config).catch(() => null) as { values?: { messages?: OfficeMessage[] } } | null;
    const baseLen = (beforeState?.values?.messages ?? []).length;

    const checkpointMessages = (beforeState?.values?.messages ?? []) as BaseMessage[];
    try {
      assertNonEmptyMessages(checkpointMessages, "resumeOfficeSession");
    } catch (guardErr) {
      log.error({ chatId, err: (guardErr as Error).message }, "resumeOffice guard: checkpoint invalid");
      await session.onSystemNotice(
        `❌ <b>Cannot resume — conversation state is invalid.</b>\n\nUse /reset to clear the thread and try again.`,
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

    const next = await getPendingApproval(office, config);
    if (next) {
      trace.event("hitl.interrupt", { title: next.title, rePaused: true });
      await sendApprovalCard(session, next);
      return;
    }
    const row = await getPendingInterrupt(session.threadId);
    if (row) await resolveInterrupt(row.interrupt_id, "approved");
    const freshMessages = sliceFreshMessages(res.messages ?? [], baseLen);
    const freshRes = { messages: freshMessages.length > 0 ? freshMessages : res.messages };
    await sendResult(session, freshRes, chatId);
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
      await session.onSystemNotice(`💰 <b>Run stopped — budget limit reached</b>\n<code>${safeHtml(err.reason)}</code>`);
      return;
    }
    if (err instanceof GraphRecursionError) {
      log.warn({ chatId }, "Resume stopped: recursion limit reached");
      await clearThreadAfterAbort(chatId);
      await session.onSystemNotice(`🔁 <b>That got stuck in a loop</b> and I stopped it. I've cleared that task — send your next message normally.`);
      return;
    }
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    log.error({ err: msg, chatId }, "Office resume failed");
    await session.onSystemNotice(`❌ <b>Resume failed</b>\n<code>${safeHtml(msg.slice(0, 1200))}</code>`);
  }
}
