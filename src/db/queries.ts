/**
 * FounderOS — Named Query Functions
 * ===================================
 * Type-safe, named query functions — no raw SQL scattered in agent files.
 * All queries go through Drizzle's query builder.
 *
 * Pattern: verbs + domain — createInterrupt, resolveInterrupt, logCost, checkIdempotency
 */

import { and, desc, eq, gt, lt, or, sql } from "drizzle-orm";
import { getDb } from "./client.js";
import {
  actionLog,
  deptSignals,
  hitlApprovals,
  outboundLeads,
  aiCallCosts,
  doNotContact,
  agentResults,
  founderContext,
  knowledgeEntries,
  conversations,
  episodicMemory,
  type NewActionLog,
  type NewDeptSignal,
  type NewHitlApproval,
  type NewOutboundLead,
  type NewAiCallCost,
  type NewDoNotContact,
  type NewAgentResult,
  type NewConversation,
  type NewEpisodicMemory,
} from "./schema.js";

// ── HITL Approvals (hitl_approvals) ──────────────────────────────────────────

/** Write a HITL approval request BEFORE calling LangGraph interrupt(). */
export async function createInterrupt(
  data: Omit<NewHitlApproval, "interrupt_id" | "created_at">,
): Promise<string> {
  const db = getDb();
  const [row] = await db
    .insert(hitlApprovals)
    .values(data)
    .returning({ interrupt_id: hitlApprovals.interrupt_id });
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
    .update(hitlApprovals)
    .set({
      status,
      resolved_at: new Date(),
      rejection_reason: opts.rejection_reason ?? null,
      edits: opts.edits ?? null,
    })
    .where(
      and(
        eq(hitlApprovals.interrupt_id, interruptId),
        eq(hitlApprovals.status, "pending"),
      ),
    )
    .returning({ interrupt_id: hitlApprovals.interrupt_id });

  return result.length > 0;
}

/** Fetch pending interrupt for a thread (max 1 active at a time). */
export async function getPendingInterrupt(threadId: string) {
  const db = getDb();
  const [row] = await db
    .select()
    .from(hitlApprovals)
    .where(
      and(
        eq(hitlApprovals.thread_id, threadId),
        eq(hitlApprovals.status, "pending"),
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
    .from(hitlApprovals)
    .where(eq(hitlApprovals.interrupt_id, interruptId))
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
    .update(hitlApprovals)
    .set({ telegram_msg_id: telegramMsgId })
    .where(eq(hitlApprovals.interrupt_id, interruptId));
}

/** Expire interrupts past their deadline (run periodically). */
export async function expireStaleInterrupts(): Promise<number> {
  const db = getDb();
  const result = await db
    .update(hitlApprovals)
    .set({ status: "expired", resolved_at: new Date() })
    .where(
      and(
        eq(hitlApprovals.status, "pending"),
        lt(hitlApprovals.expires_at, new Date()),
      ),
    )
    .returning({ interrupt_id: hitlApprovals.interrupt_id });
  return result.length;
}

// ── AI Call Costs (ai_call_costs) ─────────────────────────────────────────────

/** Record a single LLM call's token usage + cost. */
export async function logLlmCost(data: Omit<NewAiCallCost, "id" | "created_at">): Promise<void> {
  const db = getDb();
  await db.insert(aiCallCosts).values(data);
}

/** Daily total cost for a tenant. Used by cost_watchdog budget guard. */
export async function getTodayCostUsd(tenantId: string): Promise<number> {
  const db = getDb();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [row] = await db
    .select({ total: sql<string>`COALESCE(SUM(${aiCallCosts.cost_usd}), 0)` })
    .from(aiCallCosts)
    .where(
      and(
        eq(aiCallCosts.tenant_id, tenantId),
        gt(aiCallCosts.created_at, today),
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
      model: aiCallCosts.model,
      agent: aiCallCosts.agent,
      calls: sql<number>`COUNT(*)`,
      total_tokens_in: sql<number>`SUM(${aiCallCosts.tokens_in})`,
      total_tokens_out: sql<number>`SUM(${aiCallCosts.tokens_out})`,
      total_cost_usd: sql<string>`SUM(${aiCallCosts.cost_usd})`,
    })
    .from(aiCallCosts)
    .where(
      and(
        eq(aiCallCosts.tenant_id, tenantId),
        gt(aiCallCosts.created_at, since),
      ),
    )
    .groupBy(aiCallCosts.model, aiCallCosts.agent)
    .orderBy(desc(sql`SUM(${aiCallCosts.cost_usd})`));
}

// ── Action Log (action_log) ───────────────────────────────────────────────────

/**
 * Idempotency check. Returns true if the action has already been performed.
 * Call BEFORE executing any external action.
 */
export async function hasBeenAudited(idempotencyKey: string): Promise<boolean> {
  const db = getDb();
  const [row] = await db
    .select({ id: actionLog.id })
    .from(actionLog)
    .where(eq(actionLog.idempotency_key, idempotencyKey))
    .limit(1);
  return row !== undefined;
}

/**
 * Write an action log entry AFTER a successful external action.
 * Silently ignores duplicate key violations (already performed).
 */
export async function writeAuditEntry(
  data: Omit<NewActionLog, "id" | "created_at">,
): Promise<void> {
  const db = getDb();
  await db.insert(actionLog).values(data).onConflictDoNothing();
}

/** Recent action log entries for a tenant (admin/debug). */
export async function getRecentAuditEntries(tenantId: string, limit = 50) {
  const db = getDb();
  return db
    .select()
    .from(actionLog)
    .where(eq(actionLog.tenant_id, tenantId))
    .orderBy(desc(actionLog.created_at))
    .limit(limit);
}

// ── Outbound Leads (outbound_leads) ──────────────────────────────────────────

/** Create a new outbound lead entry (called by disambiguate_node on /prospect). */
export async function createLead(
  data: Omit<NewOutboundLead, "id" | "created_at" | "updated_at">,
): Promise<string> {
  const db = getDb();
  const [row] = await db
    .insert(outboundLeads)
    .values(data)
    .returning({ id: outboundLeads.id });
  if (!row) throw new Error("createLead: insert returned no rows");
  return row.id;
}

/** Update lead stage + optional metadata. */
export async function updateLeadStage(
  leadId: string,
  stage: string,
  updates: Partial<Omit<NewOutboundLead, "id" | "tenant_id" | "created_at">> = {},
): Promise<void> {
  const db = getDb();
  await db
    .update(outboundLeads)
    .set({ stage, updated_at: new Date(), ...updates })
    .where(eq(outboundLeads.id, leadId));
}

/** Fetch a lead by ID. */
export async function getLeadById(leadId: string) {
  const db = getDb();
  const [row] = await db
    .select()
    .from(outboundLeads)
    .where(eq(outboundLeads.id, leadId))
    .limit(1);
  return row ?? null;
}

/** Check if a URL is already in the pipeline for this tenant (deduplication). */
export async function getLeadByUrl(tenantId: string, companyUrl: string) {
  const db = getDb();
  const [row] = await db
    .select()
    .from(outboundLeads)
    .where(and(eq(outboundLeads.tenant_id, tenantId), eq(outboundLeads.company_url, companyUrl)))
    .limit(1);
  return row ?? null;
}

/** All leads in a given stage for a tenant. */
export async function getLeadsByStage(tenantId: string, stage: string) {
  const db = getDb();
  return db
    .select()
    .from(outboundLeads)
    .where(and(eq(outboundLeads.tenant_id, tenantId), eq(outboundLeads.stage, stage)))
    .orderBy(desc(outboundLeads.created_at));
}

// ── Do Not Contact (do_not_contact) ──────────────────────────────────────────

/** Add an address/domain to the do-not-contact list. */
export async function addSuppression(
  data: Omit<NewDoNotContact, "id" | "added_at">,
): Promise<void> {
  const db = getDb();
  await db.insert(doNotContact).values(data).onConflictDoNothing();
}

/**
 * Check if an email or its domain is on the do-not-contact list.
 * Checks both exact match and domain-prefix match (e.g. "@acme.com").
 */
export async function isSuppressed(tenantId: string, email: string): Promise<boolean> {
  const domain = "@" + email.split("@")[1];
  const db = getDb();
  const [row] = await db
    .select({ id: doNotContact.id })
    .from(doNotContact)
    .where(
      and(
        eq(doNotContact.tenant_id, tenantId),
        sql`${doNotContact.email_or_domain} IN (${email}, ${domain})`,
      ),
    )
    .limit(1);
  return row !== undefined;
}

// ── Agent Results (agent_results) — Self-Improvement ─────────────────────────

/** Write an agent result after every agent task completes. */
export async function writeTaskOutcome(
  data: Omit<NewAgentResult, "id" | "created_at">,
): Promise<void> {
  const db = getDb();
  await db.insert(agentResults).values(data);
}

/**
 * Fetch recent results for an agent — used for few-shot injection at execution time.
 * Returns top 3 succeeded + 1 failed, ordered by recency.
 */
export async function getRecentOutcomes(agentId: string, limit = 4) {
  const db = getDb();
  return db
    .select()
    .from(agentResults)
    .where(eq(agentResults.agent_id, agentId))
    .orderBy(desc(agentResults.created_at))
    .limit(limit);
}

// ── Dept Signals (dept_signals) — Cross-Department ───────────────────────────

/** Publish a cross-department signal. */
export async function publishDeptEvent(
  data: Omit<NewDeptSignal, "id" | "created_at">,
): Promise<string> {
  const db = getDb();
  const [row] = await db
    .insert(deptSignals)
    .values(data)
    .returning({ id: deptSignals.id });
  if (!row) throw new Error("publishDeptEvent: insert returned no rows");
  return row.id;
}

/** Fetch unconsumed signals for a target department. */
export async function consumePendingEvents(tenantId: string, toDept: string) {
  const db = getDb();
  const rows = await db
    .select()
    .from(deptSignals)
    .where(
      and(
        eq(deptSignals.tenant_id, tenantId),
        eq(deptSignals.consumed, false),
        eq(deptSignals.to_dept, toDept),
      ),
    )
    .orderBy(deptSignals.created_at);

  if (rows.length > 0) {
    const ids = rows.map((r) => r.id);
    await db
      .update(deptSignals)
      .set({ consumed: true })
      .where(sql`${deptSignals.id} = ANY(ARRAY[${sql.join(ids.map(id => sql`${id}::uuid`), sql`, `)}])`);
  }

  return rows;
}

// ── Founder Context (founder_context) ─────────────────────────────────────────

/** Read the founder's current business context (returns {} if not yet set). */
export async function getFounderContext(tenantId: string): Promise<Record<string, unknown>> {
  const db = getDb();
  const [row] = await db
    .select({ data: founderContext.data })
    .from(founderContext)
    .where(eq(founderContext.tenant_id, tenantId))
    .limit(1);
  return row?.data ?? {};
}

/**
 * Merge updates into the founder's context (upsert).
 * Preserves existing keys unless overwritten.
 */
export async function upsertFounderContext(
  tenantId: string,
  updates: Record<string, unknown>,
): Promise<void> {
  const db = getDb();
  const current = await getFounderContext(tenantId);
  const merged = { ...current, ...updates, last_updated: new Date().toISOString() };
  await db
    .insert(founderContext)
    .values({ tenant_id: tenantId, data: merged })
    .onConflictDoUpdate({
      target: founderContext.tenant_id,
      set: { data: merged, updated_at: new Date() },
    });
}

// ── Knowledge Entries (knowledge_entries / turicks-brain) ─────────────────────

/**
 * Full-text keyword search over turicks-brain knowledge entries.
 * Searches title + content case-insensitively.
 * Returns top N current entries ordered by recency.
 */
export async function searchKnowledgeEntries(
  tenantId: string,
  query: string,
  limit = 5,
): Promise<Array<{ title: string; content: string; entry_type: string; tags: string[] | null }>> {
  const db = getDb();
  const pattern = `%${query}%`;
  return db
    .select({
      title: knowledgeEntries.title,
      content: knowledgeEntries.content,
      entry_type: knowledgeEntries.entry_type,
      tags: knowledgeEntries.tags,
    })
    .from(knowledgeEntries)
    .where(
      and(
        eq(knowledgeEntries.tenant_id, tenantId),
        eq(knowledgeEntries.is_current, true),
        or(
          sql`${knowledgeEntries.title} ILIKE ${pattern}`,
          sql`${knowledgeEntries.content} ILIKE ${pattern}`,
        ),
      ),
    )
    .orderBy(desc(knowledgeEntries.updated_at))
    .limit(limit);
}

/** Fetch all current entries of a specific type (e.g. "adr", "brand", "case_study"). */
export async function getKnowledgeByType(
  tenantId: string,
  entryType: string,
  limit = 10,
): Promise<Array<{ title: string; content: string; tags: string[] | null }>> {
  const db = getDb();
  return db
    .select({
      title: knowledgeEntries.title,
      content: knowledgeEntries.content,
      tags: knowledgeEntries.tags,
    })
    .from(knowledgeEntries)
    .where(
      and(
        eq(knowledgeEntries.tenant_id, tenantId),
        eq(knowledgeEntries.entry_type, entryType),
        eq(knowledgeEntries.is_current, true),
      ),
    )
    .orderBy(desc(knowledgeEntries.updated_at))
    .limit(limit);
}

// ── Conversations (conversations) ─────────────────────────────────────────────

/**
 * Upsert a conversation record. Called after each Telegram run to keep the
 * summary + message_count current. Keyed on thread_id (unique).
 */
export async function upsertConversation(
  data: Omit<NewConversation, "id" | "created_at">,
): Promise<void> {
  const db = getDb();
  await db
    .insert(conversations)
    .values(data)
    .onConflictDoUpdate({
      target: conversations.thread_id,
      set: {
        summary: data.summary,
        topics: data.topics,
        message_count: data.message_count,
        last_message_at: data.last_message_at,
      },
    });
}

/**
 * Keyword search over conversation summaries + topics.
 * Returns most-recent conversations first.
 */
export async function searchConversations(
  tenantId: string,
  query: string,
  limit = 5,
): Promise<Array<{
  thread_id: string;
  summary: string | null;
  topics: string[] | null;
  last_message_at: Date | null;
  message_count: number;
}>> {
  const db = getDb();
  const pattern = `%${query}%`;
  return db
    .select({
      thread_id: conversations.thread_id,
      summary: conversations.summary,
      topics: conversations.topics,
      last_message_at: conversations.last_message_at,
      message_count: conversations.message_count,
    })
    .from(conversations)
    .where(
      and(
        eq(conversations.tenant_id, tenantId),
        or(
          sql`${conversations.summary} ILIKE ${pattern}`,
          sql`${conversations.topics}::text ILIKE ${pattern}`,
        ),
      ),
    )
    .orderBy(desc(conversations.last_message_at))
    .limit(limit);
}

// ── Episodic Memory (episodic_memory) ─────────────────────────────────────────

/**
 * Insert a new episodic event. Returns the auto-assigned ID.
 * Called by the `record_event` tool (HITL-gated in practice).
 */
export async function insertEpisodicEvent(
  data: Omit<NewEpisodicMemory, "id" | "created_at">,
): Promise<string> {
  const db = getDb();
  const [row] = await db
    .insert(episodicMemory)
    .values(data)
    .returning({ id: episodicMemory.id });
  if (!row) throw new Error("insertEpisodicEvent: insert returned no rows");
  return String(row.id);
}

/**
 * Keyword search over episodic events — title + summary ILIKE match.
 * Returns most-recent events first.
 */
export async function searchEpisodicMemory(
  tenantId: string,
  query: string,
  limit = 5,
): Promise<Array<{
  id: number;
  title: string;
  summary: string | null;
  event_type: string;
  occurred_at: Date;
  tags: string[] | null;
  thread_id: string | null;
  source: string;
}>> {
  const db = getDb();
  const pattern = `%${query}%`;
  return db
    .select({
      id: episodicMemory.id,
      title: episodicMemory.title,
      summary: episodicMemory.summary,
      event_type: episodicMemory.event_type,
      occurred_at: episodicMemory.occurred_at,
      tags: episodicMemory.tags,
      thread_id: episodicMemory.thread_id,
      source: episodicMemory.source,
    })
    .from(episodicMemory)
    .where(
      and(
        eq(episodicMemory.tenant_id, tenantId),
        or(
          sql`${episodicMemory.title} ILIKE ${pattern}`,
          sql`${episodicMemory.summary} ILIKE ${pattern}`,
          sql`${episodicMemory.tags}::text ILIKE ${pattern}`,
        ),
      ),
    )
    .orderBy(desc(episodicMemory.occurred_at))
    .limit(limit);
}
