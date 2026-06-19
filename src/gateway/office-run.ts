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
import { TENANT, OFFICE_RECURSION_LIMIT, HISTORY_KEEP_TURNS, DAILY_BUDGET_USD } from "../core/config.js";
import { computeHistoryTrim } from "../infra/history-window.js";
import { logger } from "../infra/logger.js";
import { getOffice, getPendingApproval } from "../agents/office.js";
import type { ApprovalRequest } from "../agents/agent-tools.js";
import { clearThreadCheckpoints } from "../infra/checkpointer.js";
import { cancelPendingApprovals, getPendingInterrupt, resolveInterrupt, getTodayCostUsd } from "../db/queries.js";
import { markdownToTelegramHtml, splitForTelegram, TELEGRAM_MAX } from "./format.js";
import { buildOfficeInput } from "./pre-router.js";
import { isProvidedLinkedInPostRequest } from "./execution-guard.js";
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
  extractProvidedLinkedInPost,
  isGithubWriteRequest,
  isInternalKnowledgeRequest,
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
import { isStructuredToolFailure } from "../agents/tool-result.js";
import { safeHtml, formatApprovalCard } from "./approval-card.js";
import { createTelegramSession, createWebSession, type GatewaySession } from "./session.js";
import { departmentFromTransferTool } from "./dept-routing.js";
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
 */
const TOOL_ERROR_KEYWORDS =
  /(fail|error|not set|not configured|cannot find|blocked|unauthor|invalid|denied)/i;
const STRUCTURED_FAILURE = /"(?:success|ok)"\s*:\s*false/i;

export function isToolFailure(content: string): boolean {
  // 1. Structured failure envelope (rule #22/#24) — deterministic, 100% precise.
  if (isStructuredToolFailure(content)) return true;
  // 2. Legacy `{ success|ok: false }` JSON soft-fail flag.
  if (STRUCTURED_FAILURE.test(content)) return true;
  // 3. Fallback keyword heuristic for un-migrated tools (errors lead their message;
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

async function sendApprovalCard(session: GatewaySession, approval: ApprovalRequest): Promise<void> {
  await session.onApproval(approval);
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

  const { html, keyboard } = formatApprovalCard(pending, { afterRestart: true });
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
  await session.onApproval(pending);
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
): "shell" | "linkedin" | "inbox" | "github" | "memory" | "knowledge" | null {
  if (detectUnbackedShellClaim(userText, messages, reply)) return "shell";
  if (detectLinkedInRefusalWithoutTool(userText, messages, reply)) return "linkedin";
  if (detectUnbackedInboxClaim(userText, messages, reply)) return "inbox";
  if (detectUnbackedGithubWriteClaim(userText, messages, reply)) return "github";
  if (detectUnbackedGithubReadClaim(userText, messages, reply)) return "github";
  if (detectUnbackedMemoryClaim(userText, messages, reply, toolsCalled)) return "memory";
  if (detectUnbackedKnowledgeClaim(userText, messages, reply, toolsCalled)) return "knowledge";
  return null;
}

export function buildGuardRetryMessages(
  kind: "shell" | "linkedin" | "inbox" | "github" | "memory" | "knowledge",
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

    const invokeMessages: BaseMessage[] = buildOfficeInput(text);
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
      (msg) => log.warn({ chatId, err: msg }, "Daily budget check skipped — fail-open"),
    );

    const toolCollector = new ToolNameCollector();
    const invokeConfig = {
      ...config,
      configurable: {
        ...config.configurable,
        ...(isProvidedLinkedInPostRequest(text) ? { linkedin_user_provided: true } : {}),
      },
      callbacks: [new BudgetGuardCallback(budget, agentModel), new TraceCallback(trace), toolCollector],
      metadata: buildRunMetadata({ tenant_id: TENANT, trace_id: trace.turnId, prompt_hash: trace.promptHash }),
    };

    const res = (await office.invoke(
      { messages: invokeMessages },
      invokeConfig,
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
      const retryRes = (await office.invoke(
        { messages: retryMessages },
        {
          ...invokeConfig,
          configurable: {
            ...invokeConfig.configurable,
          },
        },
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
      message: err instanceof Error ? err.message : String(err),
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

    const shellPending = await getShellHitlPendingApproval(config);
    if (shellPending) {
      if (decision === "rejected") {
        const row = await getPendingInterrupt(session.threadId);
        if (row) await resolveInterrupt(row.interrupt_id, "rejected");
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
        (msg) => log.warn({ chatId, err: msg }, "Daily budget check skipped on shell resume — fail-open"),
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
      const row = await getPendingInterrupt(session.threadId);
      if (row) await resolveInterrupt(row.interrupt_id, "approved");
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

    await assertDailyBudgetAllowsRun(
      () => getTodayCostUsd(TENANT),
      DAILY_BUDGET_USD,
      (msg) => log.warn({ chatId, err: msg }, "Daily budget check skipped on resume — fail-open"),
    );

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
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    log.error({ err: msg, chatId }, "Office resume failed");
    await session.onSystemNotice(`❌ <b>Resume failed</b>\n<code>${safeHtml(msg.slice(0, 1200))}</code>`);
  }
}
