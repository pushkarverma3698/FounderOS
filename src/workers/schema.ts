/**
 * FounderOS — Worker Tables (Drizzle schema, NOT migrated)
 * ==========================================================
 * Drizzle table definitions for future worker persistence. These are DEFINED
 * ONLY — no migration has been run, no queries exist yet. Ready for
 * `pnpm db:migrate` when the founder wants persistence.
 *
 * All tables live in the existing `agents` schema alongside hitl_approvals,
 * missions, action_log, etc.
 */

import {
  index,
  jsonb,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { agentsSchema } from "../db/schema.js";

// ── worker_contracts ─────────────────────────────────────────────────────────

/**
 * Durable worker contract storage. One row per worker per version.
 * The contract JSON is the full WorkerContract (validated by Zod at load time).
 * The `is_active` flag marks the currently effective version.
 */
export const workerContracts = agentsSchema.table(
  "worker_contracts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: text("tenant_id").notNull().default("turicks"),

    /** Stable worker identifier (e.g. "career_operator"). */
    worker_id: text("worker_id").notNull(),

    /** semver contract version. */
    contract_version: text("contract_version").notNull(),

    /** Full contract JSON — validated by WorkerContractSchema at load time. */
    contract: jsonb("contract").notNull(),

    /** Only one version per worker_id is active at a time. */
    is_active: text("is_active").notNull().default("true"),

    created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    workerVersionIdx: index("wc_worker_version_idx").on(t.worker_id, t.contract_version),
    activeIdx: index("wc_active_idx").on(t.worker_id, t.is_active),
  }),
);

// ── worker_state ─────────────────────────────────────────────────────────────

/**
 * Lifecycle state per worker. Updated on every state transition.
 * This is what allows a replacement runtime to reconstruct a worker
 * after a crash — read the contract + this row + durable business state.
 */
export const workerState = agentsSchema.table(
  "worker_state",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: text("tenant_id").notNull().default("turicks"),

    worker_id: text("worker_id").notNull(),

    /** CREATED | CONFIGURED | READY | RUNNING | WAITING | PAUSED | BLOCKED | STOPPED | FAILED */
    status: text("status").notNull().default("CREATED"),

    contract_version: text("contract_version").notNull(),

    /** Runtime provider that last held this worker (e.g. provider identifier). */
    runtime_provider: text("runtime_provider"),

    /** Opaque runtime handle ID for reconnection. */
    runtime_id: text("runtime_id"),

    /** Reason for FAILED status. */
    failure_reason: text("failure_reason"),

    /** Number of crash recovery attempts. */
    recovery_attempts: text("recovery_attempts").notNull().default("0"),

    /** Last state transition timestamp. */
    last_transition: timestamp("last_transition", { withTimezone: true }).defaultNow(),

    created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    workerIdx: index("ws_worker_idx").on(t.worker_id),
    statusIdx: index("ws_status_idx").on(t.status),
  }),
);

// ── worker_sessions ─────────────────────────────────────────────────────────

/**
 * Execution session log for digital workers.
 * Tracks active and past runtime sessions, heartbeats, and checkpoint metadata.
 */
export const workerSessions = agentsSchema.table(
  "worker_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: text("tenant_id").notNull().default("turicks"),

    worker_id: text("worker_id").notNull(),
    session_id: text("session_id").notNull().unique(),

    /** Runtime provider identifier. */
    runtime_provider: text("runtime_provider").notNull(),

    /** active | completed | paused | crashed | terminated */
    status: text("status").notNull().default("active"),

    started_at: timestamp("started_at", { withTimezone: true }).defaultNow(),
    ended_at: timestamp("ended_at", { withTimezone: true }),
    last_heartbeat: timestamp("last_heartbeat", { withTimezone: true }).defaultNow(),

    /** Arbitrary session metadata or checkpoint state. */
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),

    created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    workerSessionIdx: index("w_sess_worker_idx").on(t.worker_id, t.status),
    sessionIdIdx: index("w_sess_session_id_idx").on(t.session_id),
  }),
);

// ── worker_objectives ────────────────────────────────────────────────────────

/**
 * Links workers to their current objectives. Objectives may reference
 * the existing missions table for mission-level tracking.
 */
export const workerObjectives = agentsSchema.table(
  "worker_objectives",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: text("tenant_id").notNull().default("turicks"),

    worker_id: text("worker_id").notNull(),

    /** Objective identifier (matches WorkerObjective.id). */
    objective_id: text("objective_id").notNull(),

    description: text("description").notNull(),

    /** critical | high | normal | low */
    priority: text("priority").notNull().default("normal"),

    /** active | completed | paused | abandoned */
    status: text("status").notNull().default("active"),

    /** FK → missions.mission_id (nullable — not all objectives are missions). */
    mission_id: uuid("mission_id"),

    created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    workerIdx: index("wo_worker_idx").on(t.worker_id, t.status),
  }),
);

// ── worker_progress ──────────────────────────────────────────────────────────

/**
 * Progress reports from workers. Enables "Where are we on X?" queries
 * without depending on the current runtime session.
 */
export const workerProgress = agentsSchema.table(
  "worker_progress",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: text("tenant_id").notNull().default("turicks"),

    worker_id: text("worker_id").notNull(),

    /** FK → missions.mission_id (nullable). */
    mission_id: uuid("mission_id"),

    task_id: text("task_id"),

    /** in_progress | completed | blocked | failed */
    status: text("status").notNull(),

    summary: text("summary").notNull(),

    blockers: jsonb("blockers").$type<string[]>(),

    next_action: text("next_action"),

    created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    workerTimeIdx: index("wp_worker_time_idx").on(t.worker_id, t.created_at),
    missionIdx: index("wp_mission_idx").on(t.mission_id),
  }),
);

// ── Type exports ─────────────────────────────────────────────────────────────

export type WorkerContractRow = typeof workerContracts.$inferSelect;
export type NewWorkerContractRow = typeof workerContracts.$inferInsert;

export type WorkerStateRow = typeof workerState.$inferSelect;
export type NewWorkerStateRow = typeof workerState.$inferInsert;

export type WorkerSessionRow = typeof workerSessions.$inferSelect;
export type NewWorkerSessionRow = typeof workerSessions.$inferInsert;

export type WorkerObjectiveRow = typeof workerObjectives.$inferSelect;
export type NewWorkerObjectiveRow = typeof workerObjectives.$inferInsert;

export type WorkerProgressRow = typeof workerProgress.$inferSelect;
export type NewWorkerProgressRow = typeof workerProgress.$inferInsert;
