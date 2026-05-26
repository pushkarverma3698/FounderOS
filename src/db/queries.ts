/**
 * FounderOS — Named Query Functions
 * ===================================
 * Type-safe, named query functions — no raw SQL scattered in agent files.
 * All queries go through Drizzle's query builder.
 *
 * Pattern: verbs + domain — createInterrupt, resolveInterrupt, logCost, checkIdempotency
 */

import { and, desc, eq, gt, lt, sql } from "drizzle-orm";
import { getDb } from "./client.js";
import {
  auditLog,
  interruptRegistry,
  llmCosts,
  type NewAuditLog,
  type NewInterruptRegistry,
  type NewLlmCost,
} from "./schema.js";

// ── Interrupt Registry ────────────────────────────────────────────────────────

/** Write an interrupt record BEFORE calling LangGraph interrupt(). */
export async function createInterrupt(
  data: Omit<NewInterruptRegistry, "interrupt_id" | "created_at">,
): Promise<string> {
  const db = getDb();
  const [row] = await db
    .insert(interruptRegistry)
    .values(data)
    .returning({ interrupt_id: interruptRegistry.interrupt_id });
  if (!row) throw new Error("createInterrupt: insert returned no rows");
  return row.interrupt_id;
}

/** Resolve an interrupt (approve or reject). Returns false if not found. */
export async function resolveInterrupt(
  interruptId: string,
  status: "approved" | "rejected" | "expired",
  opts: { rejection_reason?: string; edits?: string } = {},
): Promise<boolean> {
  const db = getDb();
  const result = await db
    .update(interruptRegistry)
    .set({
      status,
      resolved_at: new Date(),
      rejection_reason: opts.rejection_reason ?? null,
      edits: opts.edits ?? null,
    })
    .where(
      and(
        eq(interruptRegistry.interrupt_id, interruptId),
        eq(interruptRegistry.status, "pending"),
      ),
    )
    .returning({ interrupt_id: interruptRegistry.interrupt_id });

  return result.length > 0;
}

/** Fetch pending interrupt for a thread (max 1 active at a time). */
export async function getPendingInterrupt(threadId: string) {
  const db = getDb();
  const [row] = await db
    .select()
    .from(interruptRegistry)
    .where(
      and(
        eq(interruptRegistry.thread_id, threadId),
        eq(interruptRegistry.status, "pending"),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Fetch a single interrupt record by its primary key. */
export async function getInterruptById(interruptId: string) {
  const db = getDb();
  const [row] = await db
    .select()
    .from(interruptRegistry)
    .where(eq(interruptRegistry.interrupt_id, interruptId))
    .limit(1);
  return row ?? null;
}

/** Store the Telegram message_id after sending the HITL notification. */
export async function setInterruptTelegramMsg(
  interruptId: string,
  telegramMsgId: number,
): Promise<void> {
  const db = getDb();
  await db
    .update(interruptRegistry)
    .set({ telegram_msg_id: telegramMsgId })
    .where(eq(interruptRegistry.interrupt_id, interruptId));
}

/** Expire interrupts past their deadline (run periodically). */
export async function expireStaleInterrupts(): Promise<number> {
  const db = getDb();
  const result = await db
    .update(interruptRegistry)
    .set({ status: "expired", resolved_at: new Date() })
    .where(
      and(
        eq(interruptRegistry.status, "pending"),
        lt(interruptRegistry.expires_at, new Date()),
      ),
    )
    .returning({ interrupt_id: interruptRegistry.interrupt_id });
  return result.length;
}

// ── LLM Costs ─────────────────────────────────────────────────────────────────

/** Record a single LLM call's token usage + cost. */
export async function logLlmCost(data: Omit<NewLlmCost, "id" | "created_at">): Promise<void> {
  const db = getDb();
  await db.insert(llmCosts).values(data);
}

/** Daily total cost for a tenant. Used by cost_watchdog budget guard. */
export async function getTodayCostUsd(tenantId: string): Promise<number> {
  const db = getDb();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [row] = await db
    .select({ total: sql<string>`COALESCE(SUM(${llmCosts.cost_usd}), 0)` })
    .from(llmCosts)
    .where(
      and(
        eq(llmCosts.tenant_id, tenantId),
        gt(llmCosts.created_at, today),
      ),
    );

  return parseFloat(row?.total ?? "0");
}

/** Per-model cost breakdown for the last N days. */
export async function getCostBreakdown(tenantId: string, days = 7) {
  const db = getDb();
  const since = new Date(Date.now() - days * 86_400_000);

  return db
    .select({
      model: llmCosts.model,
      agent: llmCosts.agent,
      calls: sql<number>`COUNT(*)`,
      total_tokens_in: sql<number>`SUM(${llmCosts.tokens_in})`,
      total_tokens_out: sql<number>`SUM(${llmCosts.tokens_out})`,
      total_cost_usd: sql<string>`SUM(${llmCosts.cost_usd})`,
    })
    .from(llmCosts)
    .where(
      and(
        eq(llmCosts.tenant_id, tenantId),
        gt(llmCosts.created_at, since),
      ),
    )
    .groupBy(llmCosts.model, llmCosts.agent)
    .orderBy(desc(sql`SUM(${llmCosts.cost_usd})`));
}

// ── Audit Log ─────────────────────────────────────────────────────────────────

/**
 * Idempotency check. Returns true if the action has already been performed.
 * Call BEFORE executing any external action.
 */
export async function hasBeenAudited(idempotencyKey: string): Promise<boolean> {
  const db = getDb();
  const [row] = await db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(eq(auditLog.idempotency_key, idempotencyKey))
    .limit(1);
  return row !== undefined;
}

/**
 * Write an audit entry AFTER a successful external action.
 * Silently ignores duplicate key violations (already audited).
 */
export async function writeAuditEntry(
  data: Omit<NewAuditLog, "id" | "created_at">,
): Promise<void> {
  const db = getDb();
  await db.insert(auditLog).values(data).onConflictDoNothing();
}

/** Recent audit entries for a tenant (admin/debug). */
export async function getRecentAuditEntries(tenantId: string, limit = 50) {
  const db = getDb();
  return db
    .select()
    .from(auditLog)
    .where(eq(auditLog.tenant_id, tenantId))
    .orderBy(desc(auditLog.created_at))
    .limit(limit);
}
