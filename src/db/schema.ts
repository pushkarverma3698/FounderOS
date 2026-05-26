/**
 * FounderOS — Database Schema
 * ============================
 * All Drizzle table definitions live here.
 * Run `pnpm db:migrate` to apply changes.
 *
 * Tables:
 *  - interrupt_registry  HITL approval queue (hot path — indexed on status+thread)
 *  - llm_costs           Per-call token + cost tracking for cost_watchdog
 *  - audit_log           Idempotency guard for all external actions
 *
 * Multi-tenant: tenant_id on every table — zero schema changes to add tenant 3+.
 */

import {
  bigint,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

// ── interrupt_registry ────────────────────────────────────────────────────────

/**
 * Durable HITL queue. Every LangGraph interrupt() call must write here FIRST.
 * Telegram callback_query resolves by interrupt_id.
 */
export const interruptRegistry = pgTable(
  "interrupt_registry",
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
    threadStatusIdx: index("ir_thread_status_idx").on(t.thread_id, t.status),
    /** Cleanup job: find expired rows */
    expiresIdx: index("ir_expires_idx").on(t.expires_at),
  }),
);

// ── llm_costs ─────────────────────────────────────────────────────────────────

/**
 * Per-call LLM cost record. Written after every successful LLM response.
 * Queried by cost_watchdog agent every Sunday.
 */
export const llmCosts = pgTable(
  "llm_costs",
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
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    /** Aggregate queries by tenant + date range */
    tenantDateIdx: index("lc_tenant_date_idx").on(t.tenant_id, t.created_at),
    /** Per-agent cost breakdown */
    agentIdx: index("lc_agent_idx").on(t.agent),
  }),
);

// ── audit_log ─────────────────────────────────────────────────────────────────

/**
 * Idempotency guard for all external side-effects.
 * Before: email_sent, telegram_send, github_push, linkedin_post
 * Agent checks: SELECT 1 FROM audit_log WHERE idempotency_key = $1
 * If found → skip. Otherwise → act + insert.
 */
export const auditLog = pgTable(
  "audit_log",
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

// ── Type exports ──────────────────────────────────────────────────────────────

export type InterruptRegistry = typeof interruptRegistry.$inferSelect;
export type NewInterruptRegistry = typeof interruptRegistry.$inferInsert;

export type LlmCost = typeof llmCosts.$inferSelect;
export type NewLlmCost = typeof llmCosts.$inferInsert;

export type AuditLog = typeof auditLog.$inferSelect;
export type NewAuditLog = typeof auditLog.$inferInsert;
