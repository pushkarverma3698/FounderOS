/**
 * FounderOS — Database Schema
 * ============================
 * All Drizzle table definitions live here.
 * Run `pnpm db:migrate` to apply changes.
 *
 * Tables (Phase 1):
 *  - hitl_approvals   HITL approval queue (hot path — indexed on status+thread)
 *  - ai_call_costs    Per-call token + cost tracking (with lead_id for Phase 2)
 *  - action_log       Idempotency guard for all external actions
 *
 * Tables (Phase 2):
 *  - outbound_leads   Outbound prospect state machine
 *  - do_not_contact   GDPR/CAN-SPAM do-not-contact list
 *
 * Tables (Phase 3):
 *  - agent_results    Agent self-improvement data + few-shot examples
 *  - dept_signals     Durable cross-department signals
 *
 * Tables (Phase C):
 *  - founder_context  Live business state — active clients, deals, priorities (1 row / tenant)
 *
 * Multi-tenant: tenant_id on every table — zero schema changes to add tenant 3+.
 */

import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

// ── hitl_approvals ────────────────────────────────────────────────────────────

/**
 * Durable HITL queue. Every LangGraph interrupt() call must write here FIRST.
 * Telegram callback_query resolves by interrupt_id.
 * Old name: interrupt_registry
 */
export const hitlApprovals = pgTable(
  "hitl_approvals",
  {
    interrupt_id: uuid("interrupt_id").primaryKey().defaultRandom(),

    /** LangGraph thread id — format: {tenant}:{user}:{run} */
    thread_id: text("thread_id").notNull(),

    tenant_id: text("tenant_id").notNull().default("turicks"),

    /** pending | approved | rejected | expired */
    status: text("status").notNull().default("pending"),

    /** Telegram message_id of the inline-keyboard approval message */
    telegram_msg_id: bigint("telegram_msg_id", { mode: "number" }),

    /** JSON payload the agent needs to resume (e.g. { draft, context }) */
    callback_data: text("callback_data"),

    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
    resolved_at: timestamp("resolved_at", { withTimezone: true }),

    /** Human's rejection reason — stored for training data */
    rejection_reason: text("rejection_reason"),

    /** Human edits applied before approving */
    edits: text("edits"),
  },
  (t) => ({
    /** Hot path: resolve HITL via thread_id + status filter */
    threadStatusIdx: index("ha_thread_status_idx").on(t.thread_id, t.status),
    /** Cleanup job: find expired rows */
    expiresIdx: index("ha_expires_idx").on(t.expires_at),
  }),
);

// ── ai_call_costs ─────────────────────────────────────────────────────────────

/**
 * Per-call LLM cost record. Written after every successful LLM response.
 * Queried by cost_watchdog agent every Sunday.
 * Old name: llm_costs
 */
export const aiCallCosts = pgTable(
  "ai_call_costs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: text("tenant_id").notNull(),
    agent: text("agent").notNull(),
    tier: text("tier").notNull(),
    model: text("model").notNull(),
    tokens_in: integer("tokens_in").notNull(),
    tokens_out: integer("tokens_out").notNull(),
    /** Calculated: (tokens_in * input_rate + tokens_out * output_rate) / 1_000_000 */
    cost_usd: numeric("cost_usd", { precision: 10, scale: 6 }).notNull(),
    /** FK → outbound_leads.id — enables per-lead cost attribution (Phase 2) */
    lead_id: uuid("lead_id"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    /** Aggregate queries by tenant + date range */
    tenantDateIdx: index("acc_tenant_date_idx").on(t.tenant_id, t.created_at),
    /** Per-agent cost breakdown */
    agentIdx: index("acc_agent_idx").on(t.agent),
  }),
);

// ── action_log ────────────────────────────────────────────────────────────────

/**
 * Idempotency guard for all external side-effects.
 * Before: email_sent, telegram_send, github_push, linkedin_post
 * Agent checks: SELECT 1 FROM action_log WHERE idempotency_key = $1
 * If found → skip. Otherwise → act + insert.
 * Old name: audit_log
 */
export const actionLog = pgTable(
  "action_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: text("tenant_id").notNull(),

    /** e.g. "email_sent" | "github_pr" | "telegram_send" | "linkedin_post" */
    action: text("action").notNull(),

    /**
     * Prevents duplicate external actions across retries/restarts.
     * Format: {action}:{thread_id}:{content_hash}
     */
    idempotency_key: text("idempotency_key").unique(),

    /** Full payload for audit trail — PII scrubbed by telemetry layer */
    payload: jsonb("payload"),

    created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    /** Idempotency lookup — unique constraint handles collision */
    idemIdx: index("al_idem_idx").on(t.idempotency_key),
    /** Audit queries by tenant + action type */
    tenantActionIdx: index("al_tenant_action_idx").on(t.tenant_id, t.action),
  }),
);

// ── outbound_leads ────────────────────────────────────────────────────────────

/**
 * Outbound prospect state machine. One row per company URL being researched.
 * Stages: researching → disqualified | drafting → approved → sent → replied → won | lost
 * Kicked off by /prospect command in Telegram.
 * Old name: lead_pipeline
 */
export const outboundLeads = pgTable(
  "outbound_leads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: text("tenant_id").notNull(),
    company_url: text("company_url").notNull(),
    company_name: text("company_name"),

    /**
     * Stage machine:
     * researching → disqualified (icp_score < 0.4)
     * researching → drafting     (icp_score >= 0.4)
     * drafting    → approved     (HITL approved)
     * approved    → sent         (email/LinkedIn sent)
     * sent        → replied      (reply detected by Gmail poller)
     * replied     → won | lost   (manual close)
     * *          → abandoned_hitl (HITL expired)
     */
    stage: text("stage").notNull().default("researching"),

    /** 0.0–1.0 score from icp_scorer node */
    icp_score: numeric("icp_score", { precision: 4, scale: 3 }),

    /** One-line rationale from the scoring LLM — shown in Telegram digest */
    icp_rationale: text("icp_rationale"),

    /** "md" | "ceo" — banded by icp_score, drives which tier the BDR uses */
    outreach_tier: text("outreach_tier"),

    /** Gmail thread ID for reply detection in scheduler poller */
    email_thread_id: text("email_thread_id"),

    created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    /** Hot path: filter by tenant + stage for pipeline dashboard */
    tenantStageIdx: index("ol_tenant_stage_idx").on(t.tenant_id, t.stage),
    /** Deduplication: prevent researching the same URL twice */
    urlIdx: index("ol_url_idx").on(t.company_url),
  }),
);

// ── do_not_contact ────────────────────────────────────────────────────────────

/**
 * GDPR/CAN-SPAM mandatory. Every outbound send must check here FIRST.
 * Supports both exact email addresses and domain-level suppression.
 * Old name: suppression_list
 */
export const doNotContact = pgTable(
  "do_not_contact",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: text("tenant_id").notNull(),

    /** Email address OR domain prefix e.g. "@acme.com" */
    email_or_domain: text("email_or_domain").notNull().unique(),

    /** unsubscribed | bounced | competitor | do_not_contact */
    reason: text("reason").notNull(),

    added_at: timestamp("added_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    /** Check lookup: tenant + email/domain */
    tenantEmailIdx: index("dnc_tenant_email_idx").on(t.tenant_id, t.email_or_domain),
  }),
);

// ── agent_results ─────────────────────────────────────────────────────────────

/**
 * Foundation for agent self-improvement (Phase 3).
 * Written after every task by pod finalize nodes.
 * Queried at execution time to inject few-shot examples into system prompts.
 * NOT compile-time — examples injected fresh per invocation.
 * Old name: task_outcomes
 */
export const agentResults = pgTable(
  "agent_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: text("tenant_id").notNull(),

    /** e.g. "bdr", "icp_scorer", "eng_engineer" */
    agent_id: text("agent_id").notNull(),

    /** LangGraph thread this task ran in */
    thread_id: text("thread_id").notNull(),

    /** FK → outbound_leads.id (nullable for non-sales tasks) */
    lead_id: uuid("lead_id"),

    /** succeeded | failed | hitl_rejected | hitl_approved */
    outcome: text("outcome").notNull(),

    /** What the agent decided — used as the few-shot example text */
    decision_summary: text("decision_summary"),

    /** Array of tool names called during the task */
    tools_used: jsonb("tools_used"),

    /** Human rejection reason or edit from HITL — training signal */
    user_feedback: text("user_feedback"),

    cost_usd: numeric("cost_usd", { precision: 10, scale: 6 }),
    latency_ms: integer("latency_ms"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    /** Few-shot query: latest outcomes for a specific agent */
    agentOutcomeIdx: index("ar_agent_outcome_idx").on(t.agent_id, t.outcome),
    /** Cost analysis: by tenant + date */
    tenantDateIdx: index("ar_tenant_date_idx").on(t.tenant_id, t.created_at),
  }),
);

// ── dept_signals ──────────────────────────────────────────────────────────────

/**
 * Durable cross-department signals (Phase 3).
 * ephemeral: departmentSignals channel in FounderState (bounded to 50, per-run)
 * durable:   this table (persists across LangGraph runs, polled by scheduler)
 *
 * Examples:
 *   sales → engineering: "proposal_approved" with { tech_requirements }
 *   engineering → sales: "demo_ready" with { demo_url }
 * Old name: dept_events
 */
export const deptSignals = pgTable(
  "dept_signals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: text("tenant_id").notNull(),

    /** "sales" | "engineering" | "marketing" | "social" | "prospecting" */
    from_dept: text("from_dept").notNull(),

    /** null = broadcast to all departments */
    to_dept: text("to_dept"),

    /** e.g. "proposal_approved", "lead_replied", "demo_ready" */
    event_type: text("event_type").notNull(),

    /** Arbitrary payload — schema defined by event_type convention */
    payload: jsonb("payload"),

    /** LangGraph thread that emitted this event */
    thread_id: text("thread_id"),

    /** Set to true once the target department has processed this event */
    consumed: boolean("consumed").notNull().default(false),

    created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    /** Scheduler poll: find unconsumed events for a department */
    unconsumedIdx: index("ds_unconsumed_idx").on(t.tenant_id, t.consumed, t.to_dept),
  }),
);

// ── knowledge_entries (turicks-brain — Phase 3) ───────────────────────────────

/**
 * turicks-brain knowledge store.
 * Stores brand decisions, ADRs, case study milestones, strategic pillars,
 * and any structured knowledge produced by agents or humans.
 *
 * This is the single source of truth for cross-session context and self-optimization.
 * All architectural decisions, phase completions, and brand updates write here.
 *
 * Sync script: scripts/sync-turicks-brain.ts
 */
export const knowledgeEntries = pgTable(
  "knowledge_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: text("tenant_id").notNull().default("turicks"),

    /** Category: "adr" | "brand" | "case_study" | "strategic_pillar" | "phase" | "decision" | "agent_output" */
    entry_type: text("entry_type").notNull(),

    /** Human-readable title for the entry */
    title: text("title").notNull(),

    /** Full content (markdown or plain text) */
    content: text("content").notNull(),

    /** Source file or system that generated this entry */
    source: text("source"),

    /** Semantic tags for retrieval (e.g. ["brand", "voice", "linkedin"]) */
    tags: jsonb("tags").$type<string[]>().default([]),

    /** Version counter — bump when content is updated, never delete rows */
    version: integer("version").notNull().default(1),

    /** Whether this is the current active version (old versions set to false) */
    is_current: boolean("is_current").notNull().default(true),

    /** Free-form metadata (phase number, pillar index, ADR number, etc.) */
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),

    created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    /** Fast lookup by type + tenant */
    typeIdx: index("ke_type_idx").on(t.tenant_id, t.entry_type, t.is_current),
    /** Tag search (JSONB contains) */
    titleIdx: index("ke_title_idx").on(t.title),
  }),
);

// ── Type exports ──────────────────────────────────────────────────────────────

export type HitlApproval = typeof hitlApprovals.$inferSelect;
export type NewHitlApproval = typeof hitlApprovals.$inferInsert;

export type AiCallCost = typeof aiCallCosts.$inferSelect;
export type NewAiCallCost = typeof aiCallCosts.$inferInsert;

export type ActionLog = typeof actionLog.$inferSelect;
export type NewActionLog = typeof actionLog.$inferInsert;

export type OutboundLead = typeof outboundLeads.$inferSelect;
export type NewOutboundLead = typeof outboundLeads.$inferInsert;

export type DoNotContact = typeof doNotContact.$inferSelect;
export type NewDoNotContact = typeof doNotContact.$inferInsert;

export type AgentResult = typeof agentResults.$inferSelect;
export type NewAgentResult = typeof agentResults.$inferInsert;

export type DeptSignal = typeof deptSignals.$inferSelect;
export type NewDeptSignal = typeof deptSignals.$inferInsert;

export type KnowledgeEntry = typeof knowledgeEntries.$inferSelect;
export type NewKnowledgeEntry = typeof knowledgeEntries.$inferInsert;

// ── founder_context ───────────────────────────────────────────────────────────

/**
 * Live business state for the founder — one row per tenant.
 * Agents read this at session start to understand current priorities.
 * The supervisor writes to it when the founder updates context.
 *
 * Data shape (enforced by convention, not DB constraint):
 *   active_clients:     string[]  — current paying clients
 *   open_deals:         string[]  — prospects in progress
 *   current_priorities: string[]  — this week's focus areas (reset every Monday)
 *   next_actions:       string[]  — pending follow-ups
 *   notes:              string    — freeform scratchpad
 *   last_updated:       string    — ISO timestamp of last write
 */
export const founderContext = pgTable("founder_context", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenant_id: text("tenant_id").notNull().unique(),
  data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export type FounderContext = typeof founderContext.$inferSelect;
export type NewFounderContext = typeof founderContext.$inferInsert;

// ── conversations ─────────────────────────────────────────────────────────────

/**
 * Searchable conversation records — written by conversation-recorder after
 * each Telegram session completes. Provides episodic memory ("what did we
 * discuss Tuesday?") beyond raw LangGraph checkpoint blobs.
 *
 * One row per thread_id. Upserted on each turn so the summary + message_count
 * stay current without accumulating duplicate rows.
 */
export const conversations = pgTable(
  "conversations",
  {
    id: serial("id").primaryKey(),

    /** LangGraph thread id — format: {tenant}:{chatId} */
    thread_id: text("thread_id").notNull().unique(),

    tenant_id: text("tenant_id").notNull().default("turicks"),

    /** ISO timestamp of first message in this thread */
    started_at: timestamp("started_at", { withTimezone: true }),

    /** ISO timestamp of most recent message — updated on every turn */
    last_message_at: timestamp("last_message_at", { withTimezone: true }),

    /** Auto-generated 1–3 sentence summary of the conversation */
    summary: text("summary"),

    /** Extracted topic tags for keyword search, e.g. ["stripe", "onboarding"] */
    topics: jsonb("topics").$type<string[]>().default([]),

    /** Total messages seen so far in this thread */
    message_count: integer("message_count").notNull().default(0),

    created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    /** Lookup conversation by tenant + recency */
    tenantTimeIdx: index("conv_tenant_time_idx").on(t.tenant_id, t.last_message_at),
  }),
);

export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;

// ── episodic_memory ───────────────────────────────────────────────────────────

/**
 * Time-ordered event log — the founder's episodic memory.
 * Stores significant events: decisions made, tasks completed, outcomes,
 * and conversation highlights worth recalling later.
 *
 * Agents write to this via the `record_event` tool (HITL-gated).
 * The `search_memory` tool queries this table alongside knowledge_entries
 * and founder_context to answer "what happened with X?" questions.
 */
export const episodicMemory = pgTable(
  "episodic_memory",
  {
    id: serial("id").primaryKey(),

    tenant_id: text("tenant_id").notNull().default("turicks"),

    /** conversation | decision | outcome | task_completed */
    event_type: text("event_type").notNull(),

    /** When the event actually happened (not when it was written) */
    occurred_at: timestamp("occurred_at", { withTimezone: true }).notNull(),

    /** Short, searchable title — e.g. "Discussed Stripe integration with Alex" */
    title: text("title").notNull(),

    /** 1–3 sentence summary of what happened and why it matters */
    summary: text("summary"),

    /** Searchable keyword tags — e.g. ["stripe", "alex", "backend"] */
    tags: jsonb("tags").$type<string[]>().default([]),

    /** Links back to the LangGraph conversation thread if relevant */
    thread_id: text("thread_id"),

    /** telegram | manual | scheduled */
    source: text("source").notNull().default("telegram"),

    created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    /** Time-ordered queries: most recent events first */
    tenantTimeIdx: index("em_tenant_time_idx").on(t.tenant_id, t.occurred_at),
    /** Keyword search on title */
    titleIdx: index("em_title_idx").on(t.title),
  }),
);

export type EpisodicMemory = typeof episodicMemory.$inferSelect;
export type NewEpisodicMemory = typeof episodicMemory.$inferInsert;

// ── Backwards-compatible aliases (remove after Phase 3 migration) ─────────────
// Keep old names in case any external scripts reference them
export const interruptRegistry = hitlApprovals;
export const llmCosts = aiCallCosts;
export const auditLog = actionLog;
export const leadPipeline = outboundLeads;
export const suppressionList = doNotContact;
export const taskOutcomes = agentResults;
export const deptEvents = deptSignals;
