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
import { TENANT, OFFICE_RECURSION_LIMIT, HISTORY_KEEP_TURNS, DAILY_BUDGET_USD, OFFICE_TURN_TIMEOUT_MS, MAX_CONCURRENT_CHAT_LOCKS, FORCE_TOOL_CHOICE_ENABLED } from "../core/config.js";
import { withTurnTimeout, TurnTimeoutError } from "./turn-timeout.js";
import { computeHistoryTrim } from "../infra/history-window.js";
import { logger } from "../infra/logger.js";
import { getOffice, getPendingApproval, getFallbackOffice } from "../agents/office.js";
import type { ApprovalRequest } from "../agents/agent-tools.js";
import { clearThreadCheckpoints } from "../infra/checkpointer.js";
import { cancelPendingApprovals, getPendingInterrupt, resolveInterrupt, getTodayCostUsd } from "../db/queries.js";
import { markdownToTelegramHtml, splitForTelegram, TELEGRAM_MAX } from "./format.js";
import { buildOfficeInput, buildRecoveryOfficeInput, preRouteDepartment, resolveForcedTool } from "./pre-router.js";
import { is503Error, isQuotaExhaustedError } from "../agents/model.js";
import { getActiveCompany } from "./active-company.js";
import { isProvidedLinkedInPostRequest } from "./execution-guard.js";
import {
  attemptLoopRecovery,
  buildRecoveryInput,
  RECOVERY_RECURSION_LIMIT,
  LOOP_RECOVERY_FAILED_MESSAGE,
} from "./loop-recovery.js";
import {
  aiMessageLooksFabricatedKnowledge,
  buildKnowledgeGroundingRefusal,
  detectLinkedInRefusalWithoutTool,
  detectUnbackedGithubReadClaim,
  detectUnbackedGithubWriteClaim,
  detectUnbackedInboxClaim,
  detectUnbackedKnowledgeClaim,
  detectUnbackedMemoryClaim,
  detectUnbackedShellClaim,
  detectUnbackedWebResearchClaim,
  extractProvidedLinkedInPost,
  isGithubWriteRequest,
  isInternalKnowledgeRequest,
  redactInjectionEcho,
} from "./execution-guard.js";
import { tryInboxReadFastPath } from "./inbox-fast-path.js";
import { tryGithubReadFastPath } from "./github-read-fast-path.js";
import {
  getShellHitlPendingApproval,
  invokeShellHitlFastPath,
  isShellHitlRequest,
  resumeShellHitlFastPath,
  shellFastPathThreadId,
} from "./shell-hitl-fast-path.js";
import { assertNonEmptyMessages } from "../infra/office-guard.js";
import { isWedgedState, type WedgeState } from "../infra/wedge.js";
import { BudgetExceededError, BudgetGuardCallback, createRunBudget } from "../infra/budget.js";
import {
  assertDailyBudgetAllowsRun,
  DailyBudgetExceededError,
} from "../infra/daily-budget.js";
import { recordConversationEnd } from "../infra/conversation-recorder.js";
import { startTurn, activePromptHash, type TurnTrace } from "../infra/trace.js";
import { readHalt, formatHaltNotice } from "../infra/halt.js";
import { TraceCallback, ToolNameCollector } from "../infra/trace-callback.js";
import { buildRunMetadata } from "../infra/telemetry.js";
import { SUPERVISOR_PROMPT } from "../agents/system-prompts.js";
import { isStructuredToolFailure, isToolNotice } from "../agents/tool-result.js";
import { safeHtml, formatApprovalCard } from "./approval-card.js";
import { createTelegramSession, createWebSession, type GatewaySession } from "./session.js";
import { departmentFromTransferTool } from "./dept-routing.js";
import { syncMissionTrace, refreshMissionDashboard } from "./mission-sync.js";

const log = logger.child({ module: "office-run" });

/** Only re-post HITL cards paused within this window (crash recovery, not ancient E2E junk). */
export const HITL_RESTORE_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/** Serialize office runs per chat so slow turns cannot bleed replies into the next message. */
const chatTurnChains = new Map<string, Promise<void>>();

/** L3 fix — thrown when the concurrent-distinct-chat-lock cap is hit (see MAX_CONCURRENT_CHAT_LOCKS). */
export class TooManyConcurrentSessionsError extends Error {
  constructor(limit: number) {
    super(`Too many concurrent chat sessions in flight (limit ${limit}) — try again shortly.`);
    this.name = "TooManyConcurrentSessionsError";
  }
}

/** Test-only: clear the concurrent-lock map between tests (avoids cross-test leakage). */
export function __resetChatTurnLocksForTests(): void {
  chatTurnChains.clear();
}

export async function withChatTurnLock<T>(chatId: string | number, fn: () => Promise<T>): Promise<T> {
  const key = String(chatId);
  // L3 fix: only a genuinely NEW key can hit the cap — a chat that already has
  // an entry (queuing behind its own prior turn) is never rejected.
  if (!chatTurnChains.has(key) && chatTurnChains.size >= MAX_CONCURRENT_CHAT_LOCKS) {
    throw new TooManyConcurrentSessionsError(MAX_CONCURRENT_CHAT_LOCKS);
  }
  const tail = chatTurnChains.get(key) ?? Promise.resolve();
  let release!: () => void;
  const slot = new Promise<void>((resolve) => {
    release = resolve;
  });
  // L3 fix: the map must store — and later compare against — the SAME promise
  // reference. The previous code compared `chatTurnChains.get(key) === slot`,
  // but the value actually stored is `tail.then(() => slot)` — a DIFFERENT
  // promise object that merely resolves to `slot`'s value. Promise equality is
  // by reference, so that comparison was always false: the cleanup branch
  // never ran, and a key was never removed from the map once used — the exact
  // "unbounded growth" the audit named, just more absolute than described (not
  // "no burst cap", but "never actually self-cleans at all"). Found by writing
  // a real regression test (tests/unit/gateway/chat-lock-cap.test.ts) that
  // asserted capacity is freed after a turn completes — it failed until this
  // was fixed, confirming the bug was real, not a testing artifact.
  const chain = tail.then(() => slot);
  chatTurnChains.set(key, chain);
  await tail;
  try {
    return await fn();
  } finally {
    release();
    if (chatTurnChains.get(key) === chain) chatTurnChains.delete(key);
  }
}

// ── Safe HTML (re-export for backwards compatibility) ─────────────────────────

export { safeHtml, formatApprovalCard } from "./approval-card.js";

function threadIdFor(chatId: number | string): string {
  return `${TENANT}:${chatId}`;
}

/**
 * H1 fix: resolve the interrupt_id of whatever is CURRENTLY pending on a
 * thread, checking both the normal thread and its shell-fast-path variant
 * (run_shell approvals are gated through a separate one-node graph keyed on
 * `shellFastPathThreadId(threadId)` — see shell-hitl-fast-path.ts). Returns
 * undefined (never throws) when no DB row can be found, in which case callers
 * degrade to the pre-H1 behaviour of not binding the card to a specific id.
 */
async function pendingInterruptIdForThread(threadId: string): Promise<string | undefined> {
  const direct = await getPendingInterrupt(threadId).catch(() => null);
  if (direct) return direct.interrupt_id;
  const shell = await getPendingInterrupt(shellFastPathThreadId(threadId)).catch(() => null);
  return shell?.interrupt_id ?? undefined;
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
      return redactInjectionEcho(stripXmlTags(text.trim()));
    }
  }
  // Pass 2: fall back to last tool message so engineering/shell results surface.
  // M1 fix: this path used to skip the same injection-echo redaction pass 1
  // applies — a tool result surfaced verbatim here (e.g. a scraped page or
  // email body that itself contains injected "reply with X" text) reached the
  // founder unscrubbed even though the AI-text path never would have.
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    const type = m._getType?.() ?? "";
    const text = typeof m.content === "string" ? m.content : "";
    if (type === "tool" && text.trim()) {
      return redactInjectionEcho(stripXmlTags(text.trim()));
    }
  }
  log.warn("finalReply: no AI or tool message found — office completed without producing output");
  return "⚠️ No reply generated — agent completed without output. Check /runs.";
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
 *
 * M4 fix (2026-07-06): the first-line keyword heuristic still false-positived
 * on a class of messages that ARE on the first line and DO contain a keyword,
 * but are deliberate, successful soft-declines, not failures — e.g. comms.ts's
 * "BLOCKED: alice@x.com is on the do-not-contact list. Email not sent." (the
 * tool correctly did NOT send, per the founder's own suppression policy) or
 * "Daily email limit reached...". These were flagged with a scary "⚠️ Tool
 * issue" banner despite being 100% correct outcomes. Rather than a 40+ tool
 * file migration to the structured envelope (the "finish migrating everything"
 * ask is a much larger follow-up), the 4 known deliberate-soft-decline call
 * sites in comms.ts now wrap their message in `toolNotice()` — a distinct
 * marker checked FIRST, below — so this specific, real false-positive class is
 * fixed without touching the 38 other tool files that were never mis-flagging
 * in the first place.
 */
const TOOL_ERROR_KEYWORDS =
  /(fail|error|not set|not configured|cannot find|blocked|unauthor|invalid|denied)/i;
const STRUCTURED_FAILURE = /"(?:success|ok)"\s*:\s*false/i;

export function isToolFailure(content: string): boolean {
  // 1. Structured failure envelope (rule #22/#24) — deterministic, 100% precise.
  if (isStructuredToolFailure(content)) return true;
  // 2. Legacy `{ success|ok: false }` JSON soft-fail flag.
  if (STRUCTURED_FAILURE.test(content)) return true;
  // 3. Explicit non-failure notice (M4) — never a failure, regardless of keywords.
  if (isToolNotice(content)) return false;
  // 4. Fallback keyword heuristic for un-migrated tools (errors lead their message;
  //    content bodies do not — only the FIRST LINE is checked to avoid false positives).
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
  // Checkpoint-first ordering (P1 fix): clear the LangGraph checkpoint BEFORE
  // marking the DB row resolved. A crash between these two is recoverable:
  // the boot scan re-runs getPendingApproval() and finds the checkpoint still
  // interrupted, then can retry. If we mark the DB first and crash before the
  // checkpoint is cleared, the HITL row is gone but the thread is stuck forever.
  await office.invoke(new Command({ resume: "rejected" }), config);
  const threadId = config?.configurable?.thread_id as string | undefined;
  if (threadId) {
    const row = await getPendingInterrupt(threadId);
    if (row) await resolveInterrupt(row.interrupt_id, "rejected");
  }
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
    session.emitStream("turn.complete", {
      reply,
      toolErrors: errs.length > 0 ? errs : undefined,
    });
    log.info(
      { sessionId: session.id, replyPreview: reply.slice(0, 80), toolErrors: errs.length },
      "Replied via web SSE",
    );
  }
}

/**
 * M5 fix: the daily-budget check is deliberately fail-open (telemetry outage
 * must never block the founder — see daily-budget.ts), but it previously only
 * LOGGED the degradation; the founder had no way to know a cost gate had
 * silently no-op'd this turn. Now it's a visible, non-blocking notice too.
 */
export async function notifyBudgetGateDegraded(
  session: GatewaySession,
  trace: TurnTrace,
  chatId: string | number,
  context: string,
  msg: string,
): Promise<void> {
  log.warn({ chatId, err: msg }, `Daily budget check skipped (${context}) — fail-open`);
  trace.event("gate.degraded", { gate: "daily_budget", context, reason: msg.slice(0, 200) });
  await session.onSystemNotice(
    `⚠️ <b>Daily budget check unavailable</b> — proceeding without a spend cap this turn (telemetry error). ` +
      `Cost is still logged normally; only the pre-run cap check was skipped.`,
  ).catch(() => {
    /* best-effort — never block the turn on this notice failing to send */
  });
}

async function sendApprovalCard(session: GatewaySession, approval: ApprovalRequest): Promise<void> {
  const interruptId = await pendingInterruptIdForThread(session.threadId);
  await session.onApproval(approval, interruptId);
}

function enrichTraceData(seam: string, data?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!data) return data;
  if (seam === "tool.call" || seam === "tool.result") {
    const toolName = String(data["name"] ?? data["tool"] ?? data["toolName"] ?? "tool");
    const routed = departmentFromTransferTool(toolName);
    return {
      ...data,
      toolName,
      department: routed ?? data["department"],
    };
  }
  return data;
}

function streamTypeForSeam(seam: string): Parameters<GatewaySession["emitStream"]>[0] | null {
  if (seam === "hitl.interrupt" || seam === "route.decided") return null;
  if (seam === "tool.call") return "tool.start";
  if (seam === "tool.result") return "tool.end";
  if (seam === "turn.out") return "turn.complete";
  if (seam === "turn.error") return "turn.error";
  return "tool.start";
}

function wrapTrace(session: GatewaySession, trace: TurnTrace): TurnTrace {
  return {
    ...trace,
    event(seam, data) {
      trace.event(seam, data);
      if (seam === "turn.out" && session.transport === "web") {
        void syncMissionTrace(session.id, trace, seam, data);
        return;
      }
      const enriched = enrichTraceData(seam, data);
      const streamType = streamTypeForSeam(seam);
      if (streamType) {
        session.emitStream(streamType, enriched);
        if (seam === "tool.call" && enriched?.department) {
          session.emitStream("department.routed", {
            department: enriched.department,
            hint: enriched.department,
          });
        }
      }
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

  const interruptId = await pendingInterruptIdForThread(threadIdFor(chatId));
  const { html, keyboard } = formatApprovalCard(pending, { afterRestart: true, interruptId });
  const { getBot } = await import("./telegram.js");
  await getBot().api.sendMessage(chatId, html, { parse_mode: "HTML", reply_markup: keyboard });
  log.info({ chatId, title: pending.title }, "Re-posted pending HITL card after restart");
  return true;
}

/** Default JARVIS web session id (thread turicks:jarvis-desktop). */
export const JARVIS_DESKTOP_SESSION = "jarvis-desktop";

/** Re-publish pending HITL to web SSE clients after process restart. */
export async function restorePendingWebHitl(sessionId = JARVIS_DESKTOP_SESSION): Promise<boolean> {
  if (await clearStalePendingInterruptOnBoot(sessionId)) return false;

  const office = await getOffice();
  const config = officeConfig(sessionId);
  const pending = await getPendingApproval(office, config);
  if (!pending) return false;

  const session = createWebSession(sessionId);
  const interruptId = await pendingInterruptIdForThread(threadIdFor(sessionId));
  await session.onApproval(pending, interruptId);
  log.info({ sessionId, title: pending.title }, "Re-published pending HITL via web SSE after restart");
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

/**
 * Remove fabricated AI messages from the checkpoint so the next turn cannot
 * re-anchor on stale ICP/strategy text (prod "reiterates stale replies" class).
 */
async function purgeFabricatedAiFromCheckpoint(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  office: { updateState: (config: any, update: { messages: RemoveMessage[] }) => Promise<unknown> },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: any,
  freshMessages: OfficeMessage[],
): Promise<number> {
  const removals: RemoveMessage[] = [];
  for (const m of freshMessages) {
    if ((m._getType?.() ?? "") !== "ai") continue;
    const id = (m as BaseMessage).id;
    if (id) removals.push(new RemoveMessage({ id }));
  }
  if (removals.length === 0) return 0;
  await office.updateState(config, { messages: removals });
  return removals.length;
}

/**
 * Before an internal-facts turn, strip prior AI messages that look like
 * fabricated Turicks knowledge so the model cannot regurgitate them without tools.
 */
async function purgeStaleFabricatedKnowledgeFromCheckpoint(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  office: {
    getState: (config: any) => Promise<unknown>;
    updateState: (config: any, update: { messages: RemoveMessage[] }) => Promise<unknown>;
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: any,
): Promise<number> {
  const state = (await office.getState(config).catch(() => null)) as {
    values?: { messages?: OfficeMessage[] };
  } | null;
  const messages: OfficeMessage[] = state?.values?.messages ?? [];
  const removals: RemoveMessage[] = [];
  for (const m of messages) {
    if ((m._getType?.() ?? "") !== "ai") continue;
    const raw = typeof m.content === "string" ? m.content : "";
    if (!aiMessageLooksFabricatedKnowledge(stripXmlTags(raw))) continue;
    const id = (m as BaseMessage).id;
    if (id) removals.push(new RemoveMessage({ id }));
  }
  if (removals.length === 0) return 0;
  await office.updateState(config, { messages: removals });
  return removals.length;
}

// ── Route an incoming message into the office ──────────────────────────────────

export function needsExecutionGuardRetry(
  userText: string,
  messages: OfficeMessage[],
  reply: string,
  toolsCalled?: readonly string[],
): "shell" | "linkedin" | "inbox" | "github" | "web" | "memory" | "knowledge" | null {
  if (detectUnbackedShellClaim(userText, messages, reply)) return "shell";
  if (detectLinkedInRefusalWithoutTool(userText, messages, reply)) return "linkedin";
  if (detectUnbackedInboxClaim(userText, messages, reply)) return "inbox";
  if (detectUnbackedGithubWriteClaim(userText, messages, reply)) return "github";
  if (detectUnbackedGithubReadClaim(userText, messages, reply)) return "github";
  // Web research BEFORE memory/knowledge: a "latest news" refusal must retry with
  // search_web, not be force-refused as an unbacked internal-knowledge claim.
  if (detectUnbackedWebResearchClaim(userText, messages, reply, toolsCalled)) return "web";
  if (detectUnbackedMemoryClaim(userText, messages, reply, toolsCalled)) return "memory";
  if (detectUnbackedKnowledgeClaim(userText, messages, reply, toolsCalled)) return "knowledge";
  return null;
}

export function buildGuardRetryMessages(
  kind: "shell" | "linkedin" | "inbox" | "github" | "web" | "memory" | "knowledge",
  userText: string,
): BaseMessage[] {
  if (kind === "memory") {
    return [
      new SystemMessage(
        "[RETRY DIRECTIVE: Your previous reply answered an internal-knowledge question " +
          "from your own memory without checking FounderOS state. Call read_context AND " +
          "search_knowledge (and search_memory if relevant) NOW before answering. Relay only " +
          "what the tools return — if they return nothing, say the knowledge base has no entry. " +
          "Never fabricate facts about Turicks, Naggar, or the founder.]",
      ),
      new HumanMessage(userText),
    ];
  }
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
  if (kind === "github") {
    if (isGithubWriteRequest(userText)) {
      return [
        new SystemMessage(
          "[RETRY DIRECTIVE: Your previous reply falsely claimed a GitHub issue/PR/repo was created. " +
            "Call github_write NOW with the exact owner, repo, title, and body. " +
            "Do NOT claim success until github_write returns ✅ after founder approval.]",
        ),
        new HumanMessage(userText),
      ];
    }
    const ownerRepo = userText.match(/\b([\w-]+\/[\w.-]+)\b/);
    return [
      new SystemMessage(
        "[RETRY DIRECTIVE: Your previous reply listed GitHub data without calling github_read. " +
          "Call github_read NOW (list_issues for open issues) and return the tool output verbatim." +
          (ownerRepo ? ` Use owner/repo ${ownerRepo[1]}.` : ""),
      ),
      new HumanMessage(userText),
    ];
  }
  if (kind === "web") {
    return [
      new SystemMessage(
        "[RETRY DIRECTIVE: Your previous reply refused a request for fresh/external information " +
          "claiming you have no real-time or web access. You DO — the research department owns " +
          "search_web. Call search_web NOW for each topic the founder asked about and answer from " +
          "the results. Never say you lack internet/real-time access without first calling search_web.]",
      ),
      new HumanMessage(userText),
    ];
  }
  if (kind === "knowledge") {
    return [
      new SystemMessage(
        "[RETRY DIRECTIVE: Your previous reply invented or guessed Turicks/business facts. " +
          "Call search_knowledge AND search_turicks_brain for the topic. " +
          "If both return no entries, reply ONLY that turicks-brain has no entry (suggest brain:sync). " +
          "Do NOT invent ICP, strategy, clients, or positioning.]",
      ),
      new HumanMessage(userText),
    ];
  }
  return [
    new SystemMessage(
      (() => {
        const provided = extractProvidedLinkedInPost(userText);
        const body =
          "[RETRY DIRECTIVE: Never refuse LinkedIn posts for banned phrases or word count. " +
          "Call linkedin_post — banned phrases are auto-stripped; the founder decides length on the approval card.";
        if (provided) {
          return `${body} Use this exact text: """${provided.slice(0, 2500)}"""`;
        }
        return body;
      })(),
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
  await runOfficeSession(session, text);
}

/**
 * Transport-neutral office run (Telegram + web gateways).
 *
 * The per-session lock lives HERE — not in the Telegram wrapper — so every
 * caller (web `web.ts`, Telegram `runOfficeText`) is serialized per chat.
 * Without it, two concurrent same-session web turns race the LangGraph
 * Postgres checkpointer and overwrite each other's state. See
 * web-concurrency.test.ts.
 */
export async function runOfficeSession(session: GatewaySession, text: string): Promise<void> {
  try {
    await withChatTurnLock(session.id, () => runOfficeSessionLocked(session, text));
  } catch (err) {
    if (err instanceof TooManyConcurrentSessionsError) {
      log.warn({ chatId: session.id }, "Turn refused — concurrent-session cap reached");
      await session.onSystemNotice(
        "🚦 <b>Too many sessions running right now.</b> Please try again in a moment.",
      );
      return;
    }
    throw err;
  }
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

    const githubFast = await tryGithubReadFastPath(text);
    if (githubFast) {
      stopTyping();
      trace.event("github.fastpath", { textLen: text.length });
      log.info({ chatId }, "GitHub issue list via fast path");
      if (session.transport === "telegram") {
        for (const chunk of splitForTelegram(markdownToTelegramHtml(githubFast))) {
          await session.onHtml(chunk);
        }
      } else {
        await session.onReply(githubFast);
      }
      return;
    }

    if (isShellHitlRequest(text)) {
      const shellHitl = await invokeShellHitlFastPath(config, text);
      if (shellHitl) {
        stopTyping();
        trace.event("shell.fastpath", { textLen: text.length });
        log.info({ chatId }, "Shell command via HITL fast path");
        const approval = await getShellHitlPendingApproval(config);
        if (approval) {
          trace.event("hitl.interrupt", { title: approval.title, shellFastPath: true });
          await sendApprovalCard(session, approval);
        } else {
          // Shell fast-path ran but the approval card could not be fetched — surface this
          // rather than silently returning with the typing indicator stopped and no reply.
          log.warn({ chatId }, "Shell fast-path: invoke succeeded but approval card is null");
          await session.onSystemNotice("⚠️ Shell command queued but approval card could not be fetched — check /status.");
        }
        return;
      }
    }

    const beforeState = await office.getState(config).catch((err) => {
      log.warn({ chatId, err: (err as Error).message }, "getState failed — baseLen will be 0");
      return null;
    }) as { values?: { messages?: OfficeMessage[] } } | null;
    const baseLen = (beforeState?.values?.messages ?? []).length;

    const budget = createRunBudget();
    const agentModel = process.env["AGENT_MODEL"] ?? "gemini-2.5-flash";

    const invokeMessages: BaseMessage[] = buildOfficeInput(text, getActiveCompany(chatId));
    trace.event("route.decided", { hint: (invokeMessages[0]?.content ?? "").toString().slice(0, 60) });

    if (isInternalKnowledgeRequest(text)) {
      const stalePurged = await purgeStaleFabricatedKnowledgeFromCheckpoint(office, config).catch((err) => {
        log.warn({ chatId, err: (err as Error).message }, "Failed to purge stale fabricated knowledge");
        return 0;
      });
      if (stalePurged > 0) {
        trace.event("guard.purged", { removed: stalePurged, stale: true });
        log.info({ chatId, removed: stalePurged }, "Purged stale fabricated knowledge from checkpoint");
      }
    }

    assertNonEmptyMessages(invokeMessages, "runOfficeSession");

    await assertDailyBudgetAllowsRun(
      () => getTodayCostUsd(TENANT),
      DAILY_BUDGET_USD,
      (msg) => void notifyBudgetGateDegraded(session, trace, chatId, "new turn", msg),
    );

    // H4 fix — flag-gated (default OFF, see FORCE_TOOL_CHOICE_ENABLED doc).
    // Reuses the SAME pre-router classification buildOfficeInput already used
    // to pick the CRITICAL directive text a few lines above — never a second,
    // divergent classifier.
    const preRoutedDept = FORCE_TOOL_CHOICE_ENABLED ? preRouteDepartment(text) : null;
    const forcedTool = preRoutedDept ? resolveForcedTool(preRoutedDept, text) : null;
    if (forcedTool) trace.event("tool.forced", { tool: forcedTool });

    const toolCollector = new ToolNameCollector();
    const invokeConfig = {
      ...config,
      configurable: {
        ...config.configurable,
        ...(isProvidedLinkedInPostRequest(text) ? { linkedin_user_provided: true } : {}),
        ...(forcedTool ? { forced_tool: forcedTool } : {}),
      },
      callbacks: [new BudgetGuardCallback(budget, agentModel), new TraceCallback(trace), toolCollector],
      metadata: buildRunMetadata({ tenant_id: TENANT, trace_id: trace.turnId, prompt_hash: trace.promptHash }),
    };

    const res = (await withTurnTimeout(
      office.invoke({ messages: invokeMessages }, invokeConfig),
      OFFICE_TURN_TIMEOUT_MS,
      "office.invoke",
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
    let toolsCalled = [...new Set(toolCollector.tools)];

    const guardKind = needsExecutionGuardRetry(
      text,
      freshRes.messages ?? [],
      finalReply(freshRes),
      toolsCalled,
    );
    if (guardKind) {
      trace.event("guard.retry", { kind: guardKind });
      log.warn({ chatId, kind: guardKind }, "Execution guard retry — model skipped gated tool");
      const retryMessages = buildGuardRetryMessages(guardKind, text);
      assertNonEmptyMessages(retryMessages, "executionGuardRetry");
      const retryBefore = (await office.getState(config).catch(() => null)) as {
        values?: { messages?: OfficeMessage[] };
      } | null;
      const retryBaseLen = (retryBefore?.values?.messages ?? []).length;
      const retryRes = (await withTurnTimeout(
        office.invoke(
          { messages: retryMessages },
          {
            ...invokeConfig,
            configurable: {
              ...invokeConfig.configurable,
            },
          },
        ),
        OFFICE_TURN_TIMEOUT_MS,
        "guard-retry",
      )) as { messages?: OfficeMessage[] };
      toolsCalled = [...new Set([...toolsCalled, ...toolCollector.tools])];
      approval = await getPendingApproval(office, config);
      if (approval) {
        trace.event("hitl.interrupt", { title: approval.title, guardRetry: guardKind });
        await sendApprovalCard(session, approval);
        return;
      }
      freshMessages = sliceFreshMessages(retryRes.messages ?? [], retryBaseLen);
      freshRes = { messages: freshMessages.length > 0 ? freshMessages : retryRes.messages };
    }

    let replyText = finalReply(freshRes);
    const stillUngrounded = needsExecutionGuardRetry(
      text,
      freshRes.messages ?? [],
      replyText,
      toolsCalled,
    );
    if (stillUngrounded === "knowledge" || stillUngrounded === "memory") {
      trace.event("guard.blocked", { kind: stillUngrounded });
      log.warn({ chatId, kind: stillUngrounded }, "Guard blocked ungrounded reply — sending safe refusal");
      const purged = await purgeFabricatedAiFromCheckpoint(office, config, freshMessages).catch((err) => {
        log.warn({ chatId, err: (err as Error).message }, "Failed to purge fabricated AI from checkpoint");
        return 0;
      });
      if (purged > 0) trace.event("guard.purged", { removed: purged });
      replyText = buildKnowledgeGroundingRefusal();
      freshRes = { messages: [{ content: replyText, _getType: () => "ai" }] };
    }

    await sendResult(session, freshRes, chatId);
    trace.event("turn.out", {
      replyPreview: replyText.slice(0, 200),
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
    trace.event("turn.error", {
      kind: err instanceof Error ? err.name : "unknown",
      message: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
    });
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
    if (err instanceof DailyBudgetExceededError) {
      log.warn({ chatId, reason: err.reason }, "Run refused: daily budget exceeded");
      await session.onSystemNotice(
        `🛑 <b>Daily budget cap reached</b>\n` +
          `<code>${safeHtml(err.reason)}</code>\n\n` +
          `Check spend: <code>/budget</code> · Adjust: <code>BUDGET_DAILY_USD</code> in <code>.env</code>.`,
      );
      return;
    }
    if (err instanceof GraphRecursionError) {
      log.warn({ chatId }, "Run stopped: recursion limit reached — attempting loop recovery");
      await clearThreadAfterAbort(chatId);
      trace.event("loop.recovery.start", {});

      // Recover-or-stop (founder launch requirement): one bounded single-pass
      // retry on the freshly-cleared thread that forbids re-transferring. If it
      // produces a real answer, deliver it — the task is ultimately completed.
      const recoveryTools = new ToolNameCollector();
      const outcome = await attemptLoopRecovery(async () => {
        const office = await getOffice();
        // Recovery input carries ONLY the recovery directive — never the
        // grounding/routing/ledger directives (they contradict it; see
        // buildRecoveryOfficeInput).
        const recoveryMessages = buildRecoveryOfficeInput(buildRecoveryInput(text), getActiveCompany(chatId));
        assertNonEmptyMessages(recoveryMessages, "loopRecovery");
        const recoveryRes = (await withTurnTimeout(
          office.invoke(
            { messages: recoveryMessages },
            {
              ...config,
              recursionLimit: RECOVERY_RECURSION_LIMIT,
              callbacks: [new TraceCallback(trace), recoveryTools],
            },
          ),
          OFFICE_TURN_TIMEOUT_MS,
          "loop-recovery",
        )) as { messages?: OfficeMessage[] };
        // A recovery pass that pauses for HITL is not a completed answer — treat as
        // non-recovered so the founder gets the honest "break it down" notice.
        if (await getPendingApproval(office, config)) return "";
        return finalReply(recoveryRes);
      });

      // The recovered reply must clear the same anti-fabrication guard as a normal
      // turn — before this check the recovery path delivered exactly the unbacked
      // answer the normal path blocks (two subsystems enforcing opposite policies).
      let deliverRecovery = outcome.status === "recovered";
      if (deliverRecovery) {
        const recoveredGuard = needsExecutionGuardRetry(
          text,
          [],
          outcome.reply ?? "",
          [...new Set(recoveryTools.tools)],
        );
        if (recoveredGuard === "memory" || recoveredGuard === "knowledge") {
          trace.event("loop.recovery.guard_blocked", { kind: recoveredGuard });
          log.warn({ chatId, kind: recoveredGuard }, "Recovery reply failed grounding guard — honest stop");
          deliverRecovery = false;
        }
      }

      if (deliverRecovery) {
        trace.event("loop.recovery.ok", { replyLen: outcome.reply?.length ?? 0 });
        log.info({ chatId }, "Loop recovery completed the task on the bounded retry");
        await sendResult(session, { messages: [{ content: outcome.reply!, _getType: () => "ai" }] }, chatId);
        return;
      }

      trace.event("loop.recovery.failed", {});
      log.warn({ chatId }, "Loop recovery failed — asking founder to break the task down");
      await session.onSystemNotice(LOOP_RECOVERY_FAILED_MESSAGE);
      return;
    }
    if (err instanceof TurnTimeoutError) {
      // The worst silent-failure class: a hung invoke. Abort LOUD, never hang.
      log.error({ chatId, ms: err.ms, label: err.label }, "Run stopped: turn timeout (hung invoke)");
      await clearThreadAfterAbort(chatId);
      await session.onSystemNotice(
        `⏱️ <b>That took too long and I stopped it</b> (over ${Math.round(err.ms / 1000)}s).\n` +
          `Nothing was sent. I've cleared the task — try again, or break it into smaller steps.`,
      );
      return;
    }
    // M2 fix: provider capacity/quota errors on the SUPERVISOR's own LLM call
    // used to have no recovery — createSupervisor takes a bare model, so the
    // department-level fallback middleware never covers it. Now attempt ONE
    // retry against a separate, fallback-model-bound office (getFallbackOffice,
    // a no-op unless AGENT_FALLBACK_MODELS is configured) before giving up.
    // NOT verified live against a real provider outage (no live keys in this
    // session) — the retry reuses the SAME thread_id/checkpointer as the
    // primary office, which should be checkpoint-compatible since the graph
    // topology is identical (only the bound model differs), but that specific
    // claim wasn't exercised against a real Postgres + real model pair.
    if (is503Error(err) || isQuotaExhaustedError(err) || isProviderNoToolUseError(err)) {
      const reason = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
      log.warn({ chatId, err: reason }, "Run stopped: model provider unavailable — attempting fallback office");
      trace.event("gate.degraded", { gate: "supervisor_model", reason: reason.slice(0, 200) });

      const fallbackOffice = await getFallbackOffice().catch((fbErr) => {
        log.warn({ chatId, err: (fbErr as Error).message }, "getFallbackOffice failed — no retry available");
        return null;
      });

      if (fallbackOffice) {
        try {
          const retryMessages = buildOfficeInput(text, getActiveCompany(chatId));
          assertNonEmptyMessages(retryMessages, "supervisorFallbackRetry");
          const fallbackRes = (await withTurnTimeout(
            fallbackOffice.invoke({ messages: retryMessages }, config),
            OFFICE_TURN_TIMEOUT_MS,
            "office.invoke.fallback",
          )) as { messages?: OfficeMessage[] };

          const fallbackApproval = await getPendingApproval(fallbackOffice, config);
          if (fallbackApproval) {
            trace.event("hitl.interrupt", { title: fallbackApproval.title, fallbackOffice: true });
            await sendApprovalCard(session, fallbackApproval);
            return;
          }

          await session
            .onSystemNotice("🌩️ <i>Primary AI provider was unavailable — used the fallback model for this turn.</i>")
            .catch(() => {
              /* best-effort */
            });
          await sendResult(session, fallbackRes, chatId);
          trace.event("turn.out", { fallbackOffice: true });
          return;
        } catch (fallbackErr) {
          log.warn(
            { chatId, err: (fallbackErr as Error).message },
            "Fallback office retry also failed — falling through to standard outage notice",
          );
        }
      }

      await clearThreadAfterAbort(chatId);
      await session.onSystemNotice(
        `🌩️ <b>The AI provider is overloaded or unavailable right now</b>\n` +
          `<code>${safeHtml(reason)}</code>\n\n` +
          `Nothing was lost — send the message again in a minute.`,
      );
      return;
    }
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    log.error({ err: msg, chatId }, "Office run failed");
    await session.onSystemNotice(`❌ <b>Error</b>\n<code>${safeHtml(msg.slice(0, 1200))}</code>`);
  }
}

/**
 * OpenRouter 404 "No endpoints found that support tool use" — the configured
 * model cannot run this system at all (live-hit 2026-07-03 with hermes-3-405b).
 */
export function isProviderNoToolUseError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /no endpoints found/i.test(err.message) || (/\b404\b/.test(err.message) && /tool use/i.test(err.message));
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

/** H1 — shown when a tap's bound interrupt id no longer matches what's pending. */
const STALE_APPROVAL_NOTICE =
  "⚠️ <b>That approval is no longer current.</b> The pending action changed before you responded — " +
  "check the latest card and try again.";

export async function resumeOffice(
  ctx: Context,
  decision: "approved" | "rejected",
  expectedInterruptId?: string,
): Promise<void> {
  const session = createTelegramSession(ctx);
  await resumeOfficeSession(session, decision, expectedInterruptId);
}

/**
 * Transport-neutral HITL resume. Shares the same per-session lock as
 * {@link runOfficeSession} so an approval/reject decision cannot race a
 * concurrent message turn on the same thread.
 *
 * `expectedInterruptId` (H1) binds the decision to the specific action the
 * card was rendered for. When provided and it no longer matches what's
 * actually pending (a re-pause, a second card, a fresh turn), the decision is
 * refused rather than silently applied to a different action — closing the
 * TOCTOU window where a stale tap could approve/reject the wrong thing.
 * Omitted (older cards, callers without a resolvable id) skips the check —
 * the pre-H1 "resume whatever is pending" behaviour.
 */
export async function resumeOfficeSession(
  session: GatewaySession,
  decision: "approved" | "rejected",
  expectedInterruptId?: string,
): Promise<void> {
  try {
    await withChatTurnLock(session.id, () => resumeOfficeSessionLocked(session, decision, expectedInterruptId));
  } catch (err) {
    if (err instanceof TooManyConcurrentSessionsError) {
      log.warn({ chatId: session.id }, "Resume refused — concurrent-session cap reached");
      await session.onSystemNotice(
        "🚦 <b>Too many sessions running right now.</b> Please try again in a moment.",
      );
      return;
    }
    throw err;
  }
}

async function resumeOfficeSessionLocked(
  session: GatewaySession,
  decision: "approved" | "rejected",
  expectedInterruptId?: string,
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

    const shellPending = await getShellHitlPendingApproval(config);
    if (shellPending) {
      // Shell HITL rows live under the SHELL-suffixed thread id (hitlGate()
      // writes them keyed by the config actually used to invoke, which
      // shellFastPathConfig() sets to shellFastPathThreadId(threadId)) — not
      // session.threadId directly. This also fixes a latent bug where
      // resolveInterrupt was called with a row looked up on the WRONG thread
      // id, so shell approvals/rejections never actually resolved their DB
      // row (it sat "pending" until TTL expiry, feeding the stale-reminder cron).
      const shellRow = await getPendingInterrupt(shellFastPathThreadId(session.threadId));
      if (expectedInterruptId && shellRow?.interrupt_id !== expectedInterruptId) {
        trace.event("hitl.stale_approval", { shellFastPath: true });
        log.warn({ chatId }, "Stale shell approval decision ignored — pending action changed");
        await session.onSystemNotice(STALE_APPROVAL_NOTICE);
        return;
      }
      if (decision === "rejected") {
        if (shellRow) await resolveInterrupt(shellRow.interrupt_id, "rejected");
        await clearThreadCheckpoints(shellFastPathThreadId(session.threadId));
        await cancelGhostApprovals(chatId);
        trace.event("turn.out", { rejected: true, shellFastPath: true });
        await session.onSystemNotice(buildRejectionConfirmation(shellPending));
        log.info({ chatId, action: shellPending.action }, "Founder rejected shell fast path — no execution");
        return;
      }

      const budget = createRunBudget();
      const agentModel = process.env["AGENT_MODEL"] ?? "gemini-2.5-flash";
      await assertDailyBudgetAllowsRun(
        () => getTodayCostUsd(TENANT),
        DAILY_BUDGET_USD,
        (msg) => void notifyBudgetGateDegraded(session, trace, chatId, "shell resume", msg),
      );

      const res = await resumeShellHitlFastPath(
        {
          ...config,
          callbacks: [new BudgetGuardCallback(budget, agentModel), new TraceCallback(trace)],
          metadata: buildRunMetadata({ tenant_id: TENANT, trace_id: trace.turnId, prompt_hash: trace.promptHash }),
        },
        decision,
      );
      const nextShell = await getShellHitlPendingApproval(config);
      if (nextShell) {
        trace.event("hitl.interrupt", { title: nextShell.title, rePaused: true, shellFastPath: true });
        await sendApprovalCard(session, nextShell);
        return;
      }
      if (shellRow) await resolveInterrupt(shellRow.interrupt_id, "approved");
      const replyText = res.output ?? "✅ Shell command finished.";
      await sendResult(session, { messages: [{ content: replyText, _getType: () => "ai" }] }, chatId);
      trace.event("turn.out", {
        replyPreview: replyText.slice(0, 200),
        resumed: true,
        shellFastPath: true,
        inputTokens: budget.summary.totalInputTokens,
        outputTokens: budget.summary.totalOutputTokens,
        usd: Number(budget.summary.totalUsd.toFixed(6)),
      });
      return;
    }

    const pending = await getPendingApproval(office, config);
    if (!pending) {
      await session.onSystemNotice("ℹ️ No pending approval found — it may have already been handled.");
      return;
    }

    const currentRow = await getPendingInterrupt(session.threadId);
    if (expectedInterruptId && currentRow?.interrupt_id !== expectedInterruptId) {
      trace.event("hitl.stale_approval", {});
      log.warn(
        { chatId, expected: expectedInterruptId, current: currentRow?.interrupt_id },
        "Stale approval decision ignored — pending action changed",
      );
      await session.onSystemNotice(STALE_APPROVAL_NOTICE);
      return;
    }

    if (decision === "rejected") {
      const row = currentRow;
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

    await assertDailyBudgetAllowsRun(
      () => getTodayCostUsd(TENANT),
      DAILY_BUDGET_USD,
      (msg) => void notifyBudgetGateDegraded(session, trace, chatId, "resume", msg),
    );

    const res = (await withTurnTimeout(
      office.invoke(
        new Command({ resume: decision }),
        {
          ...config,
          callbacks: [new BudgetGuardCallback(budget, agentModel), new TraceCallback(trace)],
          metadata: buildRunMetadata({ tenant_id: TENANT, trace_id: trace.turnId, prompt_hash: trace.promptHash }),
        },
      ),
      OFFICE_TURN_TIMEOUT_MS,
      "office.resume",
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
    const replyText = finalReply(freshRes);
    await sendResult(session, freshRes, chatId);
    trace.event("turn.out", {
      replyPreview: replyText.slice(0, 200),
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
    if (err instanceof DailyBudgetExceededError) {
      log.warn({ chatId, reason: err.reason }, "Resume refused: daily budget exceeded");
      await session.onSystemNotice(
        `🛑 <b>Daily budget cap reached</b>\n<code>${safeHtml(err.reason)}</code>\n\nCheck: <code>/budget</code>`,
      );
      return;
    }
    if (err instanceof GraphRecursionError) {
      log.warn({ chatId }, "Resume stopped: recursion limit reached");
      await clearThreadAfterAbort(chatId);
      await session.onSystemNotice(`🔁 <b>That got stuck in a loop</b> and I stopped it. I've cleared that task — send your next message normally.`);
      return;
    }
    if (err instanceof TurnTimeoutError) {
      log.error({ chatId, ms: err.ms, label: err.label }, "Resume stopped: turn timeout (hung invoke)");
      await clearThreadAfterAbort(chatId);
      await session.onSystemNotice(
        `⏱️ <b>That took too long and I stopped it</b> (over ${Math.round(err.ms / 1000)}s).\n` +
          `Nothing was sent. I've cleared the task — try again.`,
      );
      return;
    }
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    log.error({ err: msg, chatId }, "Office resume failed");
    await session.onSystemNotice(`❌ <b>Resume failed</b>\n<code>${safeHtml(msg.slice(0, 1200))}</code>`);
  }
}
