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
  pgSchema,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";
import type { Recurrence as ReminderRecurrence } from "../core/time.js";

/** P5: operational tables (agents, signals, checkpoints, audit). */
export const agentsSchema = pgSchema("agents");

/** P5: knowledge / vector tables (RAG, embeddings). */
export const brainSchema = pgSchema("brain");

// ── hitl_approvals ────────────────────────────────────────────────────────────

/**
 * Durable HITL queue. Every LangGraph interrupt() call must write here FIRST.
 * Telegram callback_query resolves by interrupt_id.
 * Old name: interrupt_registry
 */
export const hitlApprovals = agentsSchema.table(
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
export const aiCallCosts = agentsSchema.table(
  "ai_call_costs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: text("tenant_id").notNull(),
    /**
     * WHO spent it — the actor, never the stage. Kernel calls write the worker
     * id ("jobhunt", "research", …) when the model was bound to that worker's
     * tools, else the stage-level actor ("planner" | "synthesizer" | "worker");
     * "kernel" means the call could not be attributed. Non-kernel writers use
     * the same convention: "research" (gap scan), "creative" (image gen).
     */
    agent: text("agent").notNull(),
    /**
     * WHICH STAGE spent it — "planner" | "worker" | "synthesizer" for kernel
     * calls, "unattributed" when the stage was unknown. Non-kernel writers use
     * their own sub-classification ("gap-scan", an image tier).
     */
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
export const actionLog = agentsSchema.table(
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

    /**
     * Full payload for the audit trail, stored VERBATIM.
     *
     * It is NOT scrubbed. The previous comment here claimed "PII scrubbed by
     * telemetry layer"; that layer only ever scrubbed the local pino/trace path
     * (src/infra/telemetry.ts), never this insert — both writers pass raw
     * `.values(data)`.
     *
     * Verbatim is the correct behaviour, not a gap: this is first-party
     * Postgres on our own box, and an audit row that redacts the recipient of
     * an email it is attesting to would not be an audit row. The boundary worth
     * guarding is third-party EXPORT, which src/infra/telemetry.ts gates.
     */
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
 * SaaS-PHASE: query helpers exist in queries.ts, but no production writer is wired.
 * Activate when /prospect command writes leads here + sales dept reads stage.
 *
 * Outbound prospect state machine. One row per company URL being researched.
 * Stages: researching → disqualified | drafting → approved → sent → replied → won | lost
 * Old name: lead_pipeline
 */
export const outboundLeads = agentsSchema.table(
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
 * GDPR/CAN-SPAM suppression list. Exact email addresses and domain-level blocks.
 * ACTIVE: isSuppressed() checks this table in send_email (comms.ts) after HITL
 * approval, before every outbound send. Covers comms + sales + jobhunt depts.
 * Old name: suppression_list
 */
export const doNotContact = agentsSchema.table(
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
 * SaaS-PHASE (Phase 3): no writer in production src/. Schema and query helpers ready.
 * Activate when pod finalize nodes start writing outcomes for few-shot injection.
 * Old name: task_outcomes
 */
export const agentResults = agentsSchema.table(
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
 * SaaS-PHASE (Phase 3): no writer in production src/. Schema ready.
 * Intended for durable cross-department event passing (e.g. sales→engineering).
 * Ephemeral equivalent already works via FounderState.departmentSignals (per-run).
 * Old name: dept_events
 */
export const deptSignals = agentsSchema.table(
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
export const knowledgeEntries = brainSchema.table(
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

    /** Optional 768-dim embedding for hybrid keyword+vector search */
    embedding: vector("embedding", { dimensions: 768 }),

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

// ── RAG vector stores (consolidated from ChromaDB — ADR-013/015 isolation) ──
// personal_rag and turicks_brain are SEPARATE tables; the access layer
// (src/db/rag-search.ts) enforces that one tool can never read the other.

export const personalRag = brainSchema.table(
  "personal_rag",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    content: text("content").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    embedding: vector("embedding", { dimensions: 768 }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
);

export const turicksBrain = brainSchema.table(
  "turicks_brain",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    content: text("content").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    embedding: vector("embedding", { dimensions: 768 }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
);

/**
 * Unified canonical brain store (ADR-038).
 * Replaces fragmented Chroma syncs and provides a single RAG source of truth
 * with rich provenance and lifecycle management.
 */
export const brainMemories = brainSchema.table(
  "brain_memories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: text("tenant_id").notNull().default("turicks"),
    
    /** e.g., conversation, decision, architecture, bug, solution, project_state, research, document, code_knowledge, preference, task */
    memory_type: text("memory_type").notNull(),
    content: text("content").notNull(),
    embedding: vector("embedding", { dimensions: 768 }),
    
    source: text("source"),
    source_id: text("source_id"),
    project: text("project"),
    
    importance: numeric("importance", { precision: 4, scale: 3 }),
    confidence: numeric("confidence", { precision: 4, scale: 3 }),
    
    /** ACTIVE | STALE | SUPERSEDED | ARCHIVED */
    status: text("status").notNull().default("ACTIVE"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    tenantTypeIdx: index("bm_tenant_type_idx").on(t.tenant_id, t.memory_type),
    statusIdx: index("bm_status_idx").on(t.status),
    projectIdx: index("bm_project_idx").on(t.project),
  }),
);

/**
 * research_cache — durable memory of web pages scraped by the research dept
 * (Apify rag-web-browser / website-content-crawler). Kept SEPARATE from the
 * curated turicks_brain so raw web content never pollutes hand-synced strategy
 * docs (ADR-013/015 separation spirit). Auto-ingested by src/infra/research-memory.ts;
 * queried by search_research_cache. Each row's metadata carries the citation
 * (source_url, title, retrieved_at) so stored findings stay verifiable.
 */
export const researchCache = brainSchema.table(
  "research_cache",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    content: text("content").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    embedding: vector("embedding", { dimensions: 768 }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
);

export type PersonalRagRow = typeof personalRag.$inferSelect;
export type NewPersonalRagRow = typeof personalRag.$inferInsert;
export type TuricksBrainRow = typeof turicksBrain.$inferSelect;
export type NewTuricksBrainRow = typeof turicksBrain.$inferInsert;
export type BrainMemoryRow = typeof brainMemories.$inferSelect;
export type NewBrainMemoryRow = typeof brainMemories.$inferInsert;
export type ResearchCacheRow = typeof researchCache.$inferSelect;
export type NewResearchCacheRow = typeof researchCache.$inferInsert;

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
export const founderContext = agentsSchema.table("founder_context", {
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
export const conversations = agentsSchema.table(
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
export const episodicMemory = agentsSchema.table(
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

// ── missions (MISO mission control) ───────────────────────────────────────────

/** MISO lifecycle phases — INIT → RUNNING → PARTIAL → AWAITING APPROVAL → COMPLETE (+ ERROR). */
export const MISSION_PHASES = [
  "INIT",
  "RUNNING",
  "PARTIAL",
  "AWAITING APPROVAL",
  "COMPLETE",
  "ERROR",
] as const;

export type MissionPhase = (typeof MISSION_PHASES)[number];

/**
 * Durable MISO mission state — one row per active/completed mission.
 * Telegram dashboard message_id stored for edit-in-place updates.
 */
export const missions = agentsSchema.table(
  "missions",
  {
    mission_id: uuid("mission_id").primaryKey().defaultRandom(),
    tenant_id: text("tenant_id").notNull().default("turicks"),
    /** Gateway session id (Telegram chatId or web session id). */
    session_id: text("session_id").notNull(),
    thread_id: text("thread_id").notNull(),
    owner: text("owner").notNull().default("founder"),
    issue_ref: text("issue_ref"),
    goal: text("goal").notNull(),
    scope: text("scope"),
    completion_criteria: text("completion_criteria"),
    risk: text("risk").default("low"),
    phase: text("phase").notNull().default("INIT"),
    department: text("department"),
    next_action: text("next_action"),
    /** Per-department status lines for MISO template — e.g. { research: "done" }. */
    agent_statuses: jsonb("agent_statuses").$type<Record<string, string>>().default({}),
    /** Telegram message_id of the pinned MISO dashboard (null for web-only missions). */
    telegram_msg_id: bigint("telegram_msg_id", { mode: "number" }),
    turn_id: uuid("turn_id"),
    started_at: timestamp("started_at", { withTimezone: true }).defaultNow(),
    completed_at: timestamp("completed_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    sessionActiveIdx: index("missions_session_active_idx").on(t.session_id, t.phase),
    tenantIdx: index("missions_tenant_idx").on(t.tenant_id, t.created_at),
  }),
);

export type Mission = typeof missions.$inferSelect;
export type NewMission = typeof missions.$inferInsert;

// ── integration_accounts (ADR-036) ────────────────────────────────────────────

/**
 * Registry of brand identities (turicks, personal, naggar) × platforms.
 * Stores credential *references* (env var names, gws profile paths) — not raw secrets.
 * Providers resolve via src/infra/account-registry.ts.
 */
export const integrationAccounts = agentsSchema.table(
  "integration_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /** turicks | personal | naggar */
    account_key: text("account_key").notNull(),

    /** google | linkedin | instagram | facebook | github */
    platform: text("platform").notNull(),

    display_name: text("display_name").notNull(),

    /** active | expired | disabled */
    status: text("status").notNull().default("active"),

    /** gws | direct | meta_graph | composio | pat */
    auth_backend: text("auth_backend").notNull(),

    /** CredentialRefs JSON — env var names, gws profile dirs, composio ids */
    credential_refs: jsonb("credential_refs").notNull().default({}),

    metadata: jsonb("metadata"),

    created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    accountPlatformUniq: index("ia_account_platform_idx").on(t.account_key, t.platform),
    statusIdx: index("ia_status_idx").on(t.status),
  }),
);

export type IntegrationAccountRow = typeof integrationAccounts.$inferSelect;
export type NewIntegrationAccountRow = typeof integrationAccounts.$inferInsert;

// ── agent_assets ──────────────────────────────────────────────────────────────

/**
 * S3 asset references — one row per file uploaded by a user or agent.
 * File content NEVER enters Postgres; only the S3 key and metadata are stored.
 * Presigned URLs are generated on-demand via generatePresignedUrl().
 */
export const agentAssets = agentsSchema.table(
  "agent_assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /** LangGraph run id that produced or consumed this file. */
    run_id: text("run_id").notNull(),

    /** Agent that uploaded the file (e.g. "personal", "engineering"). */
    agent_id: text("agent_id"),

    /** S3 key — "{prefix}/{run_id}/{uuid4}_{sanitized_filename}" */
    s3_key: text("s3_key").notNull(),

    original_filename: text("original_filename"),

    /** 'input' | 'output' | 'scratch' */
    asset_type: text("asset_type"),

    mime_type: text("mime_type"),

    created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),

    /** Nullable — set for scratch files that should be cleaned up. */
    expires_at: timestamp("expires_at", { withTimezone: true }),
  },
  (t) => ({
    runIdx: index("aa_run_idx").on(t.run_id),
    typeIdx: index("aa_type_idx").on(t.asset_type),
  }),
);

export type AgentAsset = typeof agentAssets.$inferSelect;
export type NewAgentAsset = typeof agentAssets.$inferInsert;

// ── gap_scans (AI Visibility Gap Scanner — lead-acquisition Layer 1) ──────────

/**
 * One row per finished AI-visibility gap scan — the per-vertical learning-loop
 * dataset (lead-acquisition spec §11) and the retrieval store agents query to
 * answer "what did Acme's last scan say?" / "show me every CRM scan".
 *
 * `report` is the full GapReportData (rates, evidence, causes) and `insights`
 * the multi-angle critique (funnel, threats, volatility, confidence) — both
 * stored whole as JSONB so a scan can be re-rendered or re-analyzed without
 * rerunning paid surface calls. Hot columns are broken out for indexed lookup.
 */
export const gapScans = agentsSchema.table(
  "gap_scans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: text("tenant_id").notNull().default("turicks"),

    target_name: text("target_name").notNull(),
    /** Normalized bare domain (protocol/www stripped) — the scan's natural key. */
    target_domain: text("target_domain").notNull(),
    category: text("category").notNull(),

    /** 0–100 weighted gap vs the best competitor. */
    gap_score: integer("gap_score").notNull(),
    /** Scan self-critique grade: high | medium | low. */
    confidence: text("confidence").notNull().default("low"),
    completion_rate: numeric("completion_rate", { precision: 4, scale: 3 }).notNull(),
    runs_total: integer("runs_total").notNull(),

    /** Surface ids sampled, e.g. ["google-ai","chatgpt","perplexity"]. */
    surfaces: jsonb("surfaces").$type<string[]>().notNull().default([]),
    /** Full GapReportData — rates, evidence, causes. */
    report: jsonb("report").$type<Record<string, unknown>>().notNull(),
    /** GapInsights — intent funnel, threat profile, volatility, confidence. */
    insights: jsonb("insights").$type<Record<string, unknown>>(),
    /** Rendered 1-page gap report — the outreach artifact, ready to resend. */
    markdown: text("markdown").notNull(),

    created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    /** Hot path: latest scan for a domain. */
    domainTimeIdx: index("gs_domain_time_idx").on(t.tenant_id, t.target_domain, t.created_at),
    /** Vertical dataset: all scans in a category. */
    categoryIdx: index("gs_category_idx").on(t.tenant_id, t.category),
  }),
);

export type GapScan = typeof gapScans.$inferSelect;
export type NewGapScan = typeof gapScans.$inferInsert;

// ── scheduled_posts ─────────────────────────────────────────────────────────

/**
 * Lifecycle of a queued social post. Approved-at-schedule → claimed by a sweep
 * ('posting') → published ('posted') or 'failed'. The 'posting' claim state is
 * what makes the every-minute sweep safe against overlap: a row is atomically
 * flipped to 'posting' before the provider call, so a second (overlapping) sweep
 * tick can never re-select and republish it.
 */
export const SCHEDULED_POST_STATUSES = ["scheduled", "posting", "posted", "failed", "canceled"] as const;
export type ScheduledPostStatus = (typeof SCHEDULED_POST_STATUSES)[number];

/**
 * Server-side scheduling queue for social posts. LinkedIn's Posts API has NO
 * native scheduling, so we persist the approved post here and a zero-LLM cron
 * sweep (src/infra/scheduler.ts) fires the ones whose time has arrived.
 *
 * Platform-generic on purpose: `platform` + `account_key` let the same queue
 * back Instagram/Facebook later without a schema change (ADR-036 accounts).
 * The founder approves content + time ONCE at schedule time (HITL card); the
 * sweep publishes without a second approval, so the row starts life 'scheduled'
 * (already approved). Idempotency: unique idempotency_key + status transition.
 */
export const scheduledPosts = agentsSchema.table(
  "scheduled_posts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: text("tenant_id").notNull(),

    /** linkedin | instagram | facebook — resolves the provider at fire time. */
    platform: text("platform").notNull(),

    /** Brand identity that authors the post (ADR-036), e.g. "turicks". */
    account_key: text("account_key").notNull(),

    /** Final, approved post body (pre-mention — the mention is applied at post time). */
    text: text("text").notNull(),

    /** Optional org (Company Page) to @tag: "urn:li:organization:123". */
    mention_urn: text("mention_urn"),
    /** Exact page name for the mention link (must match LinkedIn's org name). */
    mention_name: text("mention_name"),

    /** PUBLIC | CONNECTIONS. */
    visibility: text("visibility").notNull().default("PUBLIC"),

    /** When the sweep should publish this post. */
    scheduled_at: timestamp("scheduled_at", { withTimezone: true }).notNull(),

    /** scheduled | posted | failed | canceled. */
    status: text("status").notNull().default("scheduled"),

    /** Time-invariant key shared with action_log so a retried sweep never double-posts. */
    idempotency_key: text("idempotency_key").notNull().unique(),

    /** Set on success — the published post URN + URL. */
    post_id: text("post_id"),
    post_url: text("post_url"),

    /** Set on failure — provider error surfaced to the founder. */
    error: text("error"),

    created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
    posted_at: timestamp("posted_at", { withTimezone: true }),
  },
  (t) => ({
    /** Sweep hot path: pull due 'scheduled' rows ordered by time. */
    dueIdx: index("sp_due_idx").on(t.status, t.scheduled_at),
    tenantIdx: index("sp_tenant_idx").on(t.tenant_id, t.scheduled_at),
  }),
);

export type ScheduledPost = typeof scheduledPosts.$inferSelect;
export type NewScheduledPost = typeof scheduledPosts.$inferInsert;

// ── scheduled_tasks ───────────────────────────────────────────────────────────

/**
 * Lifecycle of a scheduled agent task. 'scheduled' → claimed by the sweep
 * ('running') → 'done' | 'failed', or 'canceled' by the founder. A halted/
 * over-budget system releases a claimed row back to 'scheduled' at a later
 * time (bounded by attempts), so a founder-scheduled task is never silently
 * consumed by a temporary gate.
 */
export const SCHEDULED_TASK_STATUSES = ["scheduled", "running", "done", "failed", "canceled"] as const;
export type ScheduledTaskStatus = (typeof SCHEDULED_TASK_STATUSES)[number];

/**
 * Future kernel turns, scheduled by the founder via the schedule_task tool
 * ("tomorrow 9am: summarise my LinkedIn analytics"). A zero-LLM cron sweep
 * (src/infra/scheduler.ts) claims due rows and fires each one as a normal
 * kernel turn on the founder's own thread — so HITL gating, receipts, budget
 * caps and history all apply exactly as if the founder had typed the prompt
 * at that moment. Safety is by construction: the task row itself performs no
 * side effects; any external action inside the fired turn still raises its
 * own approval card.
 */
export const scheduledTasks = agentsSchema.table(
  "scheduled_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: text("tenant_id").notNull(),

    /** What the kernel should do when the task fires — a normal turn input. */
    prompt: text("prompt").notNull(),

    /** Chat whose thread the turn runs on (and where replies/cards go). */
    chat_id: text("chat_id").notNull(),

    /** When the sweep should fire this task. */
    scheduled_at: timestamp("scheduled_at", { withTimezone: true }).notNull(),

    /** scheduled | running | done | failed | canceled. */
    status: text("status").notNull().default("scheduled"),

    /** Claim counter — bounds halt/budget deferrals so a task can't zombie. */
    attempts: integer("attempts").notNull().default(0),

    /** Time-invariant key so an interrupt() resume re-run never double-inserts. */
    idempotency_key: text("idempotency_key").notNull().unique(),

    /** Set on failure — surfaced to the founder by the sweep. */
    error: text("error"),

    /**
     * Recurrence spec (`daily@08:07` | `weekdays@09:00` | `weekly@mon:09:12` |
     * `monthly@01:06:07`), NULL for a one-shot task. On completion the sweep
     * parses this and inserts a FRESH row for the next occurrence rather than
     * mutating this one, so fired history stays immutable and a checkpoint replay
     * can never re-arm twice. Parsed by `parseRecurrence` / `nextRecurrence` in
     * src/core/time.ts, which resolve against APP_TIMEZONE.
     */
    recurrence: text("recurrence"),

    created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
    completed_at: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => ({
    /** Sweep hot path: pull due 'scheduled' rows ordered by time. */
    dueIdx: index("st_due_idx").on(t.status, t.scheduled_at),
    tenantIdx: index("st_tenant_idx").on(t.tenant_id, t.scheduled_at),
  }),
);

export type ScheduledTask = typeof scheduledTasks.$inferSelect;
export type NewScheduledTask = typeof scheduledTasks.$inferInsert;

// ── job_applications ──────────────────────────────────────────────────────────

/**
 * Application pipeline state for the Netherlands campaign.
 *
 * Exists so the machine can never re-apply to a role it has already touched, and
 * so the funnel is MEASURED rather than estimated — docs/strategy/09-NL-ENTRY-CAMPAIGN.md
 * currently carries guessed conversion rates, and this table is what replaces them.
 *
 * `dedupe_key` is the identity (normalised company + role, see
 * src/tools/jobhunt/filters.ts) and is unique per tenant: the uniqueness
 * constraint, not application logic, is what makes double-applying impossible.
 */
export const jobApplications = agentsSchema.table(
  "job_applications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: text("tenant_id").notNull(),
    /**
     * WHICH CANDIDATE this row was screened for.
     *
     * NOT NULL with a default, and both halves matter. A NULL does not conflict
     * in a unique index, so a nullable profile_id would silently disable
     * `ja_dedupe_uniq` — the one gate that makes double-applying structurally
     * impossible — for any row that failed to set it.
     */
    profile_id: text("profile_id").notNull().default("pushkar-nl-tech"),

    /** Normalised `company::role` — the identity that prevents double-applying. */
    dedupe_key: text("dedupe_key").notNull(),

    /**
     * Weaker identity (company + sorted title words, noise stripped) used to WARN
     * about cosmetic re-posts. Never unique — sorting tokens is not sound enough
     * to block an application on.
     */
    soft_dedupe_key: text("soft_dedupe_key"),

    /** hsm | remote-contract — which route's gates produced the verdict. */
    route: text("route").notNull().default("hsm"),

    company: text("company").notNull(),
    /** Canonical IND register name when the sponsor gate matched exactly. */
    registered_name: text("registered_name"),
    title: text("title").notNull(),
    url: text("url"),

    /** sponsor | not-sponsor | uncertain — from src/tools/jobhunt/sponsor-match.ts. */
    sponsor_verdict: text("sponsor_verdict").notNull(),

    /** pass | flag | reject, plus the evidence string behind the decision. */
    salary_status: text("salary_status").notNull(),
    salary_evidence: text("salary_evidence"),

    /**
     * Every gate WITH its own status: `[{gate, status, evidence}, …]`.
     *
     * `salary_evidence` above is the same information flattened to one pipe-joined
     * string, and a flat string cannot say WHICH check failed. The brief read
     * position instead of status and printed reason #1 as the row's headline, so a
     * role flagged on salary was labelled with its PASSING sponsor line — the
     * founder's first real brief was unreadable for exactly this reason. Stored as
     * text rather than jsonb: it is only ever read whole, and text keeps the
     * migration a plain ADD COLUMN on a live table.
     */
    gate_json: text("gate_json"),

    /** 0–1 CV-to-JD fit, with the matched/missing skills that produced it. */
    fit_score: numeric("fit_score"),
    fit_evidence: text("fit_evidence"),

    /** screened | drafted | awaiting_approval | applied | replied | rejected | dormant. */
    stage: text("stage").notNull().default("screened"),

    applied_at: timestamp("applied_at", { withTimezone: true }),

    /**
     * When the founder looked at this row and decided NOT to apply.
     *
     * A SEPARATE COLUMN FROM `applied_at`, never a shared status. Both remove a
     * row from the apply queue, so one field would serve the queue perfectly —
     * and would destroy the only number this pipeline exists to move. "Applied
     * and heard nothing" and "read it and passed" are opposite facts: the first
     * is a live lead and evidence the screening is aimed correctly, the second
     * is evidence it is not. Collapsed, the apply rate loses its denominator.
     *
     * It must also stay out of `applied_at` because that column drives the
     * re-apply staleness rule (`isStaleEnoughToReapply`, screen.ts): stamping a
     * skip there would suppress a role the founder passed on in March and would
     * happily take in September.
     *
     * Written only by the Mac apply client — the machine never submits an
     * application (ADR-018), so it learns either fact only from a founder click.
     * NULL on both = still in the queue.
     */
    skipped_at: timestamp("skipped_at", { withTimezone: true }),
    last_contact_at: timestamp("last_contact_at", { withTimezone: true }),
    /** Count of follow-ups sent — the Monday review follows up at day 7, then 14. */
    followups_sent: integer("followups_sent").notNull().default(0),

    notes: text("notes"),

    /**
     * The posting body, verbatim. Kept because the skill dictionary
     * (src/tools/jobhunt/skills-dictionary.ts) will gain terms over time, and
     * without the source text every signal recorded before a term was added is
     * unrecoverable — the history would silently under-count the new term.
     */
    description: text("description"),
    /** When the employer published it (from the ATS feed), not when we saw it. */
    posted_at: timestamp("posted_at", { withTimezone: true }),
    /** manual | ats-ingest | indeed-ingest — how the posting reached the gates. */
    source: text("source").notNull().default("manual"),

    /** ai | backend | frontend | unclassified — from the title, deterministically. */
    track: text("track").notNull().default("unclassified"),

    /**
     * NL | IN | other | unknown — where the FETCHER said the job is.
     *
     * Never re-derived from the ad's wording. Route classification used to read
     * the prose, so "hybrid" in an Indian posting was taken as proof of a Dutch
     * office and nine Indeed-IN rows were stored under a Dutch permit basis. The
     * feed always knew; the value was being thrown away before the screener ran.
     *
     * `other` and `unknown` are distinct. "This is in Colombia" narrows the
     * lawful bases to one; "we could not tell" is a question that must be asked.
     */
    country: text("country"),

    /** The feed's location string, verbatim — the evidence behind `country`. */
    location: text("location"),

    /** The source's own id — Indeed's job key is what its liveness lookup takes. */
    external_id: text("external_id"),

    /**
     * unknown | live | expired | unverifiable.
     *
     * `unverifiable` is a distinct value, not a synonym for expired: a network
     * failure that reads as "this job is dead" removes a real opportunity and
     * emits no signal that it did.
     */
    liveness: text("liveness").notNull().default("unknown"),
    liveness_checked_at: timestamp("liveness_checked_at", { withTimezone: true }),

    /**
     * Where this row appeared in the LAST brief, and at what number.
     *
     * Pinned at render time so `/draft 2` resolves to the row the founder was
     * looking at. Re-deriving the order on demand would silently retarget the
     * command when liveness or new screens reshuffle the list.
     */
    brief_section: text("brief_section"),
    brief_rank: integer("brief_rank"),

    /** pending | tailoring | tailored | failed — CV generation state. */
    tailor_status: text("tailor_status"),
    /**
     * Why the last tailoring attempt ended the way it did.
     *
     * ITS OWN COLUMN because `notes` has two writers. `recordTailoringResult`
     * wrote the failure reason there and `recordLiveness` overwrites the same
     * column with its own sentence on every brief render — so of 16 rows that
     * carried `tailor_status = 'failed'` in production on 2026-08-24, **14 read
     * "Confirmed still open: HTTP 200"**, which is a true statement about a
     * different question and tells nobody why the CV never got built. The two
     * surviving reasons were a Gemini 5xx and a missing Chromium, i.e. exactly
     * the two things worth knowing.
     */
    tailor_note: text("tailor_note"),
    /** S3 key to the generated, JD-tailored CV PDF. */
    tailored_cv_s3_key: text("tailored_cv_s3_key"),
    /** S3 key to the generated DOCX variant. */
    tailored_docx_s3_key: text("tailored_docx_s3_key"),
    /** S3 key to the pre-drafted cover letter. */
    cover_letter_s3_key: text("cover_letter_s3_key"),

    created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    /**
     * The gate that makes double-applying structurally impossible.
     * Scoped to (tenant_id, profile_id, dedupe_key) so that the same posting
     * can be screened independently for different candidates (e.g. Pushkar vs Wife).
     * Previously (tenant_id, dedupe_key) — screening Wife's job would overwrite
     * Pushkar's record for the same company/title.
     */
    dedupeUniq: uniqueIndex("ja_dedupe_uniq").on(t.tenant_id, t.profile_id, t.dedupe_key),
    /** Monday review hot path: live applications ordered by staleness. */
    stageIdx: index("ja_stage_idx").on(t.tenant_id, t.stage, t.last_contact_at),
    /** The brief's hot path: one track's passing postings. */
    trackVerdictIdx: index("ja_track_verdict_idx").on(t.tenant_id, t.track, t.salary_status),
    /** The apply queue's hot path: unhandled rows, best first. */
    applyQueueIdx: index("ja_apply_queue_idx").on(t.tenant_id, t.applied_at, t.brief_rank),
    /** Multi-profile filtering — added with profile_id column (0036). */
    profileIdx: index("ja_profile_idx").on(t.tenant_id, t.profile_id, t.brief_section, t.brief_rank),
  }),
);

export type JobApplication = typeof jobApplications.$inferSelect;
export type NewJobApplication = typeof jobApplications.$inferInsert;

// ── cv_signals ────────────────────────────────────────────────────────────────

/**
 * What the reachable market actually asks for, accumulated one posting at a time.
 *
 * Only postings that PASS the screening gates contribute. That restriction is
 * the whole value of the table: the market at large is noise, while the roles
 * Pushkar can legally hold are the only population his CV needs to match.
 *
 * It informs the CV; it never edits it. There is deliberately no write path from
 * here to personal-rag (ADR-015 — read-only) or to any CV document. `cv_gaps`
 * reports the difference and the founder decides what is true.
 *
 * `seen_count` is postings, NOT mentions — see src/tools/jobhunt/skills.ts.
 */
export const cvSignals = agentsSchema.table(
  "cv_signals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: text("tenant_id").notNull(),

    /** Canonical term as the founder reads it, e.g. 'Kubernetes'. */
    term: text("term").notNull(),

    /** language | framework | infra | data | ai | practice | unknown. */
    category: text("category").notNull(),

    /**
     * ai | backend | frontend | unclassified — which market asked for it.
     *
     * Part of the identity, not a label. Blended into one bucket, "Python 60%"
     * could be 100% of AI roles and 0% of frontend and the report could not tell
     * the difference — so the finding could not be acted on either way.
     */
    track: text("track").notNull().default("unclassified"),

    /** Number of DISTINCT passing postings that asked for this. */
    seen_count: integer("seen_count").notNull().default(0),

    first_seen_at: timestamp("first_seen_at", { withTimezone: true }).defaultNow(),
    last_seen_at: timestamp("last_seen_at", { withTimezone: true }).defaultNow(),

    created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    /** One row per (track, term) — the count is a running total, not an event log. */
    trackTermUniq: uniqueIndex("cv_signals_track_term_uniq").on(t.tenant_id, t.track, t.term),
    /** Gap report hot path: most-demanded first, within one track. */
    trackRankIdx: index("cv_signals_track_rank_idx").on(t.tenant_id, t.track, t.seen_count),
  }),
);

export type CvSignal = typeof cvSignals.$inferSelect;
export type NewCvSignal = typeof cvSignals.$inferInsert;

// ── job_ingest_runs ───────────────────────────────────────────────────────────

/**
 * One row per paid feed call, with what it cost and what it bought.
 *
 * The founder asked on 2026-08-01 how many times the pipeline runs and what it
 * costs, and the honest answer had to be reconstructed by hand from actor
 * pricing pages and a reading of the cron schedule. That is a question about our
 * own system that our own system could not answer, and the reconstruction is
 * stale the moment a query count changes.
 *
 * `estimated_cost_usd` is ESTIMATED and named so. Apify bills per event on its
 * own ledger and this table never sees that invoice; what it holds is our
 * arithmetic over the posted per-job and per-start prices. It is right for
 * spotting the day a sweep doubled, and it is not an accounting record.
 */
export const jobIngestRuns = agentsSchema.table(
  "job_ingest_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: text("tenant_id").notNull(),

    /** Groups every query of one sweep, so a day's cost is one GROUP BY. */
    sweep_id: uuid("sweep_id").notNull(),

    /** ats | indeed — which feed was billed. */
    feed: text("feed").notNull(),
    /** The pool or country this query covered, e.g. "netherlands" or "NL". */
    pool: text("pool").notNull(),
    /** ai | fullstack | backend | frontend, or "all" for a feed we cannot split. */
    track: text("track").notNull(),

    /** What we asked for, and what came back. A gap between them is a finding. */
    requested: integer("requested").notNull(),
    returned: integer("returned").notNull().default(0),

    /**
     * Postings that reached the gates, and how they came out.
     *
     * These five MUST sum to `screened`. Until 2026-08-05 only the first three
     * existed, so postings that came back `duplicate` or `error` were counted
     * in `screened` and nowhere else — and a sweep where every posting threw
     * looked identical to a market with nothing in it. That is how a total
     * screening outage ran unnoticed from 2026-08-02 to 2026-08-05.
     */
    screened: integer("screened").notNull().default(0),
    passed: integer("passed").notNull().default(0),
    flagged: integer("flagged").notNull().default(0),
    rejected: integer("rejected").notNull().default(0),
    duplicates: integer("duplicates").notNull().default(0),
    errored: integer("errored").notNull().default(0),

    /**
     * Why the postings in `errored` failed — the commonest message of the batch.
     *
     * Distinct from `error` below, which is the FETCH failing. This column is
     * the gates failing on postings that arrived fine. Both can be null on the
     * same row while every posting still failed, which was precisely the blind
     * spot: the message existed in memory on every line and was never written
     * down.
     */
    screen_error: text("screen_error"),

    /**
     * Postings this query found that the tracker had never seen.
     *
     * The only column here that says whether the money bought anything.
     * `returned` is what the feed BILLED us for, and on 2026-08-02 a sweep was
     * billed for 32 postings of which zero were new. Recorded per QUERY, not
     * per sweep, because "which pool still finds new roles" is what decides
     * where to cut cost — and that is not recoverable from job_applications,
     * which never records which query found a row.
     */
    fresh: integer("fresh").notNull().default(0),

    /**
     * WHERE THE POSTINGS WENT — the six stages `filterCandidates` and
     * `keepUnseen` drop rows at, in the order they run.
     *
     * `runFreeIngest` has always built this struct and always thrown it away at
     * the database boundary, so the only record of it was a log line. On
     * 2026-08-21 answering "are we dropping roles?" needed `journalctl` on the
     * production box and a regex, and the answer turned out to be worth a lot:
     * `stale` was discarding 24,446 postings per sweep against 554 rows held
     * lifetime, which means ≥23,892 open roles had never been screened once.
     *
     * A funnel that lives only in a log is a funnel nobody queries. Null on the
     * metered lane, which does not compute these — null means "not measured
     * here", never zero.
     */
    seen: integer("seen"),
    undated: integer("undated"),
    stale: integer("stale"),
    off_track: integer("off_track"),
    off_market: integer("off_market"),
    known: integer("known"),
    bodyless: integer("bodyless"),

    /** Our arithmetic over the posted per-job + per-start prices. Not an invoice. */
    estimated_cost_usd: numeric("estimated_cost_usd").notNull().default("0"),

    /** Null on success. A failed query still gets a row — it was still billed a start. */
    error: text("error"),

    created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    /** "what did this month cost" — the question the table exists to answer. */
    tenantDayIdx: index("jir_tenant_day_idx").on(t.tenant_id, t.created_at),
    sweepIdx: index("jir_sweep_idx").on(t.sweep_id),
  }),
);

export type JobIngestRun = typeof jobIngestRuns.$inferSelect;
export type NewJobIngestRun = typeof jobIngestRuns.$inferInsert;

// ── failure_lessons ───────────────────────────────────────────────────────────

/**
 * The Hermes learning seam (src/kernel/lessons.ts): one row per
 * (tenant, worker, normalized failure signature) that a corrected retry has
 * RESOLVED at least once. The kernel injects the lesson into future retries
 * of the same signature — recorded by code from validated results, never by
 * the model, so a lesson can never assert something that didn't happen.
 */
export const failureLessons = agentsSchema.table(
  "failure_lessons",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: text("tenant_id").notNull(),

    /** Worker (department) the failure occurred in. */
    worker: text("worker").notNull(),

    /** Normalized failure signature (kernel normalizeFailureSignature). */
    signature: text("signature").notNull(),

    /** Real failing component from the FailureReport. */
    component: text("component").notNull(),

    /** Objective of the step that recorded the lesson (model context). */
    objective: text("objective").notNull(),

    /** Tool names whose successful receipts backed the resolving attempt. */
    resolved_with_tools: jsonb("resolved_with_tools").$type<string[]>().notNull().default([]),

    /**
     * `times_seen` = occurrences of this signature that entered the RETRY SEAM,
     * resolved or not (see src/kernel/lessons.ts Hook 2 and its SCOPE note — it
     * is a LOWER BOUND on failures: non-retryable failures and the final attempt
     * of an exhausted step are not counted). `times_resolved`
     * = the subset of those occurrences a later retry actually fixed (what
     * `times_seen` meant before 2026-08-12; see drizzle/0029). Do not conflate
     * either with `times_applied`, which counts lesson-INJECTIONS into retries
     * (bumpFailureLessonApplied) — a third, unrelated axis.
     */
    times_seen: integer("times_seen").notNull().default(1),
    times_resolved: integer("times_resolved").notNull().default(0),
    times_applied: integer("times_applied").notNull().default(0),

    /** True only for rows backfilled by drizzle/0029's migration UPDATE. */
    migrated_from_v1: boolean("migrated_from_v1").notNull().default(false),

    /** First time this signature was ever seen (set once, never updated). */
    first_seen_at: timestamp("first_seen_at", { withTimezone: true }),
    /** Most recent counted occurrence, resolved or not (updated on every occurrence write). */
    last_seen_at: timestamp("last_seen_at", { withTimezone: true }),

    /** Most recent successful resolution — meaningful for the resolution axis only. */
    last_resolved_at: timestamp("last_resolved_at", { withTimezone: true }).notNull().defaultNow(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    /** Lookup + upsert hot path: one lesson per (tenant, worker, signature). */
    lessonKeyIdx: uniqueIndex("fl_tenant_worker_sig_idx").on(t.tenant_id, t.worker, t.signature),
  }),
);

export type FailureLessonRow = typeof failureLessons.$inferSelect;

// ── saved_workflows (reusable-script catalog) ─────────────────────────────────

/**
 * One row per distinct script/workflow the agent has run (vps_run, claude_code).
 * Modeled on failure_lessons: identity is a content `signature` (tool + command
 * + image), and `run_count` increments on every repeat — so "our most-used
 * workflows" is just `ORDER BY run_count DESC`. Scripts themselves live in S3
 * (`s3_keys`, populated for vps_run whose artifacts are uploaded); this table is
 * the findable index that lets tomorrow's agent look up and re-run a proven
 * workflow instead of re-deriving it. Written best-effort from code AFTER a run
 * has already succeeded — a catalog write must never fail a finished job.
 */
export const savedWorkflows = agentsSchema.table(
  "saved_workflows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: text("tenant_id").notNull(),

    /** Human-readable name derived from the command/brief — for eyeballing. */
    slug: text("slug").notNull(),

    /** Dedup identity: hash of (tool, command, image). One row per signature. */
    signature: text("signature").notNull(),

    /** Tool that produced the script — 'vps_run' | 'claude_code'. */
    tool: text("tool").notNull(),

    /** The script / command that was run. */
    command: text("command").notNull(),

    /** Optional context that travelled with the run. */
    brief: text("brief"),

    /** Container image (vps_run) — null for claude_code. */
    image: text("image"),

    /** S3 keys of the saved scripts/outputs (vps_run artifacts); [] otherwise. */
    s3_keys: jsonb("s3_keys").$type<string[]>().notNull().default([]),

    /** Most recent LangGraph run id that exercised this workflow. */
    last_run_id: text("last_run_id"),

    /** How many times this exact workflow has been run. */
    run_count: integer("run_count").notNull().default(1),

    first_used_at: timestamp("first_used_at", { withTimezone: true }).notNull().defaultNow(),
    last_used_at: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    /** Upsert hot path: one row per (tenant, signature). */
    workflowKeyIdx: uniqueIndex("sw_tenant_sig_idx").on(t.tenant_id, t.signature),
    /** "Most used" lookup: pull a tenant's workflows by run frequency. */
    popularityIdx: index("sw_popularity_idx").on(t.tenant_id, t.run_count),
  }),
);

export type SavedWorkflow = typeof savedWorkflows.$inferSelect;
export type NewSavedWorkflow = typeof savedWorkflows.$inferInsert;

// ── reminders (founder-facing pure ping — zero-LLM) ───────────────────────────

/**
 * A reminder NUDGES the founder — it never executes anything (that's
 * scheduled_tasks). A zero-LLM cron sweep (src/infra/scheduler.ts) claims due
 * rows and sends the text straight to chat with no kernel turn, no budget gate
 * and no HITL — so the "ping me at exactly the right time" promise can't be
 * throttled. One-shot rows go 'fired'; recurring rows re-arm (remind_at advances
 * to the next occurrence, status back to 'scheduled'). At-least-once by design:
 * a crash between send and mark re-pings rather than dropping — a duplicate
 * nudge beats a missed one.
 */
export const REMINDER_STATUSES = ["scheduled", "firing", "fired", "canceled"] as const;
export type ReminderStatus = (typeof REMINDER_STATUSES)[number];

export const reminders = agentsSchema.table(
  "reminders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: text("tenant_id").notNull(),

    /** Chat the ping is sent to. */
    chat_id: text("chat_id").notNull(),

    /** The nudge text shown to the founder at fire time. */
    text: text("text").notNull(),

    /** Next instant this reminder fires (UTC). Advances for recurring rows. */
    remind_at: timestamp("remind_at", { withTimezone: true }).notNull(),

    /** null = one-shot; else a simple repeat rule the sweep re-arms from. */
    recurrence: jsonb("recurrence").$type<ReminderRecurrence | null>(),

    /** IANA zone the founder set it in — for display + recurrence math. */
    timezone: text("timezone").notNull().default("Asia/Kolkata"),

    /** scheduled | firing | fired | canceled. */
    status: text("status").notNull().default("scheduled"),

    /** Time-invariant dedup key so an interrupt() resume never double-inserts. */
    idempotency_key: text("idempotency_key").notNull().unique(),

    /** Set on a fire error — surfaced to the founder by the sweep. */
    error: text("error"),

    created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
    /** Last instant this reminder actually pinged. */
    fired_at: timestamp("fired_at", { withTimezone: true }),
  },
  (t) => ({
    /** Sweep hot path: pull due 'scheduled' rows ordered by time. */
    dueIdx: index("rem_due_idx").on(t.status, t.remind_at),
    tenantIdx: index("rem_tenant_idx").on(t.tenant_id, t.remind_at),
  }),
);

export type Reminder = typeof reminders.$inferSelect;
export type NewReminder = typeof reminders.$inferInsert;

// ── evolution_runs / evolution_findings (self-audit memory) ───────────────────

/**
 * M0a Evolution Engine — self-audit run + finding memory.
 *
 * Before this table, every `runSelfAudit()` (src/evolution/audit-sweep.ts)
 * started from zero: it could not tell a brand-new finding from one seen 40
 * times, or one that was fixed and has now regressed. See
 * docs/plans/2026-08-12-self-improvement-audit.md §3 "Cut 2".
 *
 * `evolution_runs` is one row per audit/acting invocation. `analyzers_run`
 * records which analyzer FUNCTION NAMES actually executed that run (e.g.
 * `["findDeadExports", "findCostHotspots"]`) — a static-only run and a run
 * where telemetry was skipped (dead Postgres) both produce fewer entries here
 * than a full run. This is what makes "a finding was absent from a run"
 * interpretable: absence only means something for an analyzer whose name is
 * in this list for that run (src/evolution/persist-findings.ts).
 */
export const EVOLUTION_LOOPS = ["audit", "acting"] as const;
export type EvolutionLoop = (typeof EVOLUTION_LOOPS)[number];

export const evolutionRuns = agentsSchema.table("evolution_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenant_id: text("tenant_id").notNull(),

  started_at: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  /** Null until the run completes (or fails) — see persist-findings.ts. */
  finished_at: timestamp("finished_at", { withTimezone: true }),

  commit_sha: text("commit_sha"),
  /** 'audit' = Loop A (report-only, already scheduled) · 'acting' = Loop B (writes code). */
  loop: text("loop").notNull(),

  findings_count: integer("findings_count").notNull().default(0),
  /** Free text outcome, e.g. "completed" | "failed: <reason>". Not an enum: the
   *  failure text itself is the useful part, per the founder-legibility rule. */
  outcome: text("outcome"),

  /** Analyzer function names that actually executed this run — see doc comment above. */
  analyzers_run: jsonb("analyzers_run").$type<string[]>().notNull().default([]),
});

export type EvolutionRun = typeof evolutionRuns.$inferSelect;
export type NewEvolutionRun = typeof evolutionRuns.$inferInsert;

export const EVOLUTION_FINDING_STATUSES = ["open", "resolved", "regressed"] as const;
export type EvolutionFindingStatus = (typeof EVOLUTION_FINDING_STATUSES)[number];

/**
 * One row per (tenant, fingerprint) — the identity of a recurring finding
 * across runs, independent of cosmetic wording changes in its evidence text.
 *
 * `fingerprint` (src/evolution/fingerprint.ts) hashes `kind + location +
 * subject`, NOT `evidence`: evidence is the human-readable sentence an
 * analyzer composes fresh every run and routinely embeds volatile numbers
 * (a dollar amount, a line count, a percentage) that change between runs
 * without the underlying defect changing at all — hashing it would fracture
 * one persistent finding into a new row every run, which is the exact
 * failure this table exists to prevent. `subject` is included (the brief
 * that specified this table said "kind + location + normalised detail", but
 * `Finding` has no separate `detail` field — `location` alone collides for
 * `unused-dependency` findings, which never set it, and for multiple
 * `dead-export` findings in the same file; `subject` is this shape's actual
 * structured identity field, so it stands in for "detail" here. See
 * src/evolution/fingerprint.ts for the full reasoning.)
 *
 * `detail` stores the raw `evidence` text for display — it is written, never
 * hashed.
 *
 * `analyzer` is the analyzer function name that produced this finding
 * (e.g. "findDeadExports"). It is required for the resolution rule below:
 * `kind` is NOT 1:1 with analyzer (both `findOrphanModules` and
 * `findOrphanSubsystems` emit kind "orphan-module"), so only `analyzer`
 * lets a later run know whose absence is meaningful.
 *
 * Status machine (src/evolution/persist-findings.ts):
 *   open      — seen, not resolved.
 *   resolved  — the analyzer that found it ran again (its name is in that
 *               run's `evolution_runs.analyzers_run`) and no longer produced
 *               a finding with this fingerprint. Absence when the analyzer
 *               did NOT run means nothing and leaves the row untouched —
 *               a skipped analyzer must never look like a fixed defect.
 *   regressed — a `resolved` finding reappeared in a later run. This is the
 *               mechanism that makes "a finding recurring as inaction after
 *               being marked fixed" visible, instead of silently bumping
 *               times_seen on a row nobody would think to re-check.
 */
export const evolutionFindings = agentsSchema.table(
  "evolution_findings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: text("tenant_id").notNull(),

    /** Stable identity hash — see doc comment above and fingerprint.ts. */
    fingerprint: text("fingerprint").notNull(),

    kind: text("kind").notNull(),
    severity: text("severity").notNull(),
    /** `file:line` or a directory prefix where applicable; null for e.g. unused-dependency. */
    location: text("location"),
    /** The finding's structured identity within its kind — see doc comment above. */
    subject: text("subject").notNull(),
    /** Analyzer function name that produced this finding — see doc comment above. */
    analyzer: text("analyzer").notNull(),
    /** Raw `Finding.evidence` text, for display. Never hashed into the fingerprint. */
    detail: text("detail").notNull(),

    first_seen_at: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    last_seen_at: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    times_seen: integer("times_seen").notNull().default(1),

    /** 'open' | 'resolved' | 'regressed' — see doc comment above. */
    status: text("status").notNull().default("open"),
    resolved_at: timestamp("resolved_at", { withTimezone: true }),

    /** The run that most recently saw (or, for a resolution, last touched) this finding. */
    run_id: uuid("run_id").references(() => evolutionRuns.id),
  },
  (t) => ({
    /** Upsert hot path: one row per (tenant, fingerprint) — see persist-findings.ts. */
    tenantFingerprintIdx: uniqueIndex("ef_tenant_fingerprint_idx").on(t.tenant_id, t.fingerprint),
    /** Resolution-path lookup: "this analyzer's prior open/regressed rows". */
    tenantAnalyzerIdx: index("ef_tenant_analyzer_idx").on(t.tenant_id, t.analyzer, t.status),
  }),
);

export type EvolutionFinding = typeof evolutionFindings.$inferSelect;
export type NewEvolutionFinding = typeof evolutionFindings.$inferInsert;

// ── answer_evaluations (async answer-quality verdicts) ───────────────────────

/**
 * One row per completed turn, written ASYNCHRONOUSLY by `src/infra/answer-eval.ts`
 * after the founder already has the reply. This is an evaluator's record, never a
 * gate: a bad score here has never blocked and must never block a reply.
 *
 * `status` is the load-bearing column:
 *   evaluated      — the judge returned three scores; they are in the score columns.
 *   not_evaluated  — the judge was unreachable, unparseable, or unconfigured. Every
 *                    score column is NULL and `not_evaluated_reason` says why.
 *
 * The three dimensions are stored SEPARATELY and are never averaged into one
 * number: a reply can answer the goal perfectly (relevance 100) while asserting a
 * fact no step result supports (groundedness 0), and that is precisely the failure
 * this table exists to make visible. Groundedness is the machine-checkable
 * complement to the kernel's receipts mechanism — read it first.
 *
 * Never compute a pass rate over all rows: `WHERE status = 'evaluated'` or the
 * denominator silently absorbs every turn the judge never saw.
 */
export const answerEvaluations = agentsSchema.table(
  "answer_evaluations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: text("tenant_id").notNull(),

    /** Trace turn id — the same correlation id the logs carry. */
    turn_id: text("turn_id").notNull(),
    thread_id: text("thread_id").notNull(),

    /** 'evaluated' | 'not_evaluated' — see doc comment above. */
    status: text("status").notNull(),
    /** Full sentence naming why no scores exist. NULL iff status = 'evaluated'. */
    not_evaluated_reason: text("not_evaluated_reason"),

    /** 0-100, NULL when not evaluated. A NULL can never read as a pass. */
    groundedness: integer("groundedness"),
    relevance: integer("relevance"),
    completeness: integer("completeness"),
    /** One sentence from the judge naming the weakest dimension. */
    critique: text("critique"),

    /** Truncated copies so a row is readable on its own, without a checkpoint join. */
    goal: text("goal").notNull(),
    reply: text("reply").notNull(),
    /** How many steps the plan had — completeness is meaningless without it. */
    planned_steps: integer("planned_steps").notNull().default(0),

    /** `provider:model` of the judge, so a model swap is visible in the data. */
    judge_model: text("judge_model").notNull(),

    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    /** "recent verdicts for this tenant", the read path for any quality report. */
    tenantCreatedIdx: index("ae_tenant_created_idx").on(t.tenant_id, t.created_at),
    /** "which turns never got scored" — the outage query, kept cheap on purpose. */
    tenantStatusIdx: index("ae_tenant_status_idx").on(t.tenant_id, t.status),
    /**
     * Lookup by turn. NOT unique on purpose: a HITL resume re-runs synthesis under
     * the SAME turn id, producing a second, different answer. A unique index would
     * throw on the post-approval answer — the one that actually reached the founder.
     */
    turnIdx: index("ae_turn_idx").on(t.turn_id),
  }),
);

export type AnswerEvaluation = typeof answerEvaluations.$inferSelect;
export type NewAnswerEvaluation = typeof answerEvaluations.$inferInsert;

// ── Backwards-compatible aliases (remove after Phase 3 migration) ─────────────
// Keep old names in case any external scripts reference them
export const interruptRegistry = hitlApprovals;
export const llmCosts = aiCallCosts;
export const auditLog = actionLog;
export const leadPipeline = outboundLeads;
export const suppressionList = doNotContact;
export const taskOutcomes = agentResults;
export const deptEvents = deptSignals;
export * from "../tools/b2b/schema";
