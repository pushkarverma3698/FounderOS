/**
 * FounderOS — HITL Gateway
 * =========================
 * Human-in-the-loop interrupt lifecycle.
 *
 * Flow:
 *  1. Agent node calls requestHITL() inside a LangGraph node
 *  2. requestHITL() writes to interrupt_registry (crash-safe) BEFORE interrupt()
 *  3. Sends Telegram message with Approve / Reject buttons
 *  4. Calls LangGraph interrupt() — graph suspends, checkpoint saved
 *  5. User taps button → Telegram callback_query handler calls resolveHITL()
 *  6. resolveHITL() looks up thread_id from DB → calls resumeFn (graph.invoke Command)
 *  7. interrupt() returns decision → DB record resolved → HITLRecord returned
 *  8. Graph continues from where it was suspended
 *
 * Dependency injection (no circular imports):
 *  initHITL(sendFn, resumeFn) is called from src/index.ts after bot + graph are ready.
 */

import { interrupt, getConfig } from "@langchain/langgraph";
import type { HITLRecord } from "../agents/state.js";
import {
  createInterrupt,
  resolveInterrupt,
  getInterruptById,
  setInterruptTelegramMsg,
} from "../db/queries.js";
import { childLogger } from "../infra/logger.js";
import { getAgentTopicId } from "../core/registry.js";

const log = childLogger({ module: "hitl" });

// ── Dependency injection ──────────────────────────────────────────────────────

/** Sends HITL message to Telegram, returns telegram message_id */
type SendFn = (
  topicId: number,
  interruptId: string,
  summary: string,
  draft: string,
  agent: string,
) => Promise<number>;

/** Resumes a suspended LangGraph thread with the human's decision */
type ResumeFn = (threadId: string, decision: HITLDecision) => Promise<void>;

export interface HITLDecision {
  status: "approved" | "rejected";
  edits?: string;
  rejection_reason?: string;
}

let _sendFn: SendFn | null = null;
let _resumeFn: ResumeFn | null = null;

/**
 * Register the send + resume functions.
 * Call from src/index.ts after bot and graph are both initialised.
 */
export function initHITL(sendFn: SendFn, resumeFn: ResumeFn): void {
  _sendFn = sendFn;
  _resumeFn = resumeFn;
  log.info("HITL initialized (sendFn + resumeFn registered)");
}

// ── Request types ─────────────────────────────────────────────────────────────

export interface HITLRequest {
  thread_id: string;
  tenant_id: string;
  agent: string;
  /** Short summary shown at top of Telegram message */
  summary: string;
  /** Full draft content for preview */
  draft: string;
  /** Expire after N minutes (default: 60) */
  ttl_minutes?: number;
}

// ── Create HITL interrupt ─────────────────────────────────────────────────────

/**
 * Write the interrupt record, send Telegram notification, then call LangGraph
 * interrupt() to suspend the graph. Execution resumes here when the user taps
 * Approve or Reject, at which point the DB record is resolved and the final
 * HITLRecord (with decision) is returned.
 *
 * MUST be called from inside a LangGraph node (interrupt() requires graph context).
 */
export async function requestHITL(req: HITLRequest): Promise<HITLRecord> {
  const ttl = req.ttl_minutes ?? 60;
  const expiresAt = new Date(Date.now() + ttl * 60_000);
  const requestedAt = new Date().toISOString();

  // Use the main graph's thread_id from LangGraph context (more authoritative than req.thread_id)
  const lgConfig = getConfig();
  const threadId = (lgConfig?.configurable?.["thread_id"] as string | undefined) ?? req.thread_id;

  // 1. Write to DB BEFORE calling interrupt() — crash-safe
  const interrupt_id = await createInterrupt({
    thread_id: threadId,
    tenant_id: req.tenant_id,
    callback_data: JSON.stringify({ summary: req.summary, draft: req.draft }),
    expires_at: expiresAt,
  });

  // 2. Send Telegram message with inline keyboard
  let telegram_message_id: number | undefined;
  if (_sendFn) {
    const topicId = getAgentTopicId(req.agent);
    try {
      telegram_message_id = await _sendFn(topicId, interrupt_id, req.summary, req.draft, req.agent);
      await setInterruptTelegramMsg(interrupt_id, telegram_message_id);
    } catch (err) {
      // Non-fatal — interrupt is in DB and can be recovered on restart
      log.warn({ err, interrupt_id }, "Failed to send HITL Telegram message");
    }
  } else {
    log.warn({ interrupt_id, agent: req.agent }, "HITL sendFn not registered — Telegram message skipped");
  }

  log.info({ interrupt_id, agent: req.agent, thread_id: threadId }, "HITL interrupt created — suspending graph");

  // 3. Suspend graph — throws GraphInterrupt. Execution resumes here when
  //    graph.invoke(new Command({ resume: decision }), config) is called.
  const decision = interrupt({ interrupt_id, agent: req.agent, requested_at: requestedAt }) as HITLDecision;

  // ── Execution resumes here after human decision ───────────────────────────

  const resolvedAt = new Date().toISOString();

  // 4. Resolve the DB record
  await resolveInterrupt(interrupt_id, decision.status, {
    rejection_reason: decision.rejection_reason,
    edits: decision.edits,
  });

  log.info({ interrupt_id, decision: decision.status }, "HITL resolved — graph continuing");

  return {
    status: decision.status,
    interrupt_id,
    telegram_message_id,
    requested_at: requestedAt,
    resolved_at: resolvedAt,
    edits: decision.edits,
    rejection_reason: decision.rejection_reason,
  };
}

// ── Resolve from Telegram callback ───────────────────────────────────────────

/**
 * Called from the Telegram callback_query handler when user taps Approve/Reject.
 * Looks up the interrupt, validates it is still pending, then resumes the graph.
 *
 * Returns false if interrupt is not found, already resolved, or expired.
 */
export async function resolveHITL(
  interruptId: string,
  decision: "approved" | "rejected",
  opts: { edits?: string; rejection_reason?: string } = {},
): Promise<boolean> {
  const record = await getInterruptById(interruptId);

  if (!record) {
    log.warn({ interrupt_id: interruptId }, "resolveHITL: interrupt not found");
    return false;
  }

  if (record.status !== "pending") {
    log.warn({ interrupt_id: interruptId, status: record.status }, "resolveHITL: already resolved");
    return false;
  }

  if (new Date(record.expires_at) < new Date()) {
    log.warn({ interrupt_id: interruptId }, "resolveHITL: interrupt expired");
    return false;
  }

  if (!_resumeFn) {
    log.error({ interrupt_id: interruptId }, "resolveHITL: resumeFn not registered — cannot resume graph");
    return false;
  }

  const hitlDecision: HITLDecision = {
    status: decision,
    edits: opts.edits,
    rejection_reason: opts.rejection_reason,
  };

  try {
    await _resumeFn(record.thread_id, hitlDecision);
    return true;
  } catch (err) {
    log.error({ err, interrupt_id: interruptId, thread_id: record.thread_id }, "resolveHITL: graph resume failed");
    return false;
  }
}

// ── Message formatter ─────────────────────────────────────────────────────────

/**
 * Format an HTML approval message for Telegram.
 * safeHtml escaping is done by the caller (telegram.ts).
 */
export function formatHITLMessage(
  summary: string,
  draft: string,
  interrupt_id: string,
  agent: string,
): string {
  const preview = draft.length > 600 ? draft.slice(0, 600) + "…" : draft;
  return [
    `🔔 <b>Approval Required</b>  <i>${agent}</i>`,
    ``,
    summary,
    ``,
    `<b>Draft Preview:</b>`,
    `<pre>${preview}</pre>`,
    ``,
    `<code>${interrupt_id}</code>`,
  ].join("\n");
}
