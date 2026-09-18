/**
 * FounderOS — Worker Contract Types
 * ===================================
 * The portable identity and authority boundary for a persistent digital worker.
 *
 * A WorkerContract defines WHO the worker is, WHAT it exists to achieve, WHAT
 * responsibilities it owns, WHAT capabilities it may use, and WHICH runtime
 * currently executes it — without coupling to any specific runtime (Antigravity,
 * Claude Code, OpenClaw).
 *
 * Contracts are validated with Zod at load time. Runtime code receives the
 * inferred TypeScript type — never raw JSON.
 */

import { z } from "zod";

// ── Worker lifecycle states ──────────────────────────────────────────────────

export const WORKER_STATUSES = [
  "CREATED",
  "CONFIGURED",
  "READY",
  "RUNNING",
  "WAITING",
  "PAUSED",
  "BLOCKED",
  "STOPPED",
  "FAILED",
] as const;

export type WorkerStatus = (typeof WORKER_STATUSES)[number];

// ── Valid state transitions ──────────────────────────────────────────────────

/** Adjacency list of legal lifecycle transitions. Enforced by the lifecycle
 *  manager — any transition not listed here is rejected loudly. */
export const VALID_TRANSITIONS: Record<WorkerStatus, readonly WorkerStatus[]> = {
  CREATED:    ["CONFIGURED", "FAILED"],
  CONFIGURED: ["READY", "FAILED"],
  READY:      ["RUNNING", "STOPPED", "FAILED"],
  RUNNING:    ["WAITING", "PAUSED", "BLOCKED", "STOPPED", "FAILED"],
  WAITING:    ["RUNNING", "PAUSED", "STOPPED", "FAILED"],
  PAUSED:     ["READY", "STOPPED", "FAILED"],
  BLOCKED:    ["READY", "STOPPED", "FAILED"],
  STOPPED:    ["CREATED"],
  FAILED:     ["CREATED"],
};

// ── Schedule mode ────────────────────────────────────────────────────────────

export const SCHEDULE_MODES = ["on_demand", "scheduled", "continuous"] as const;
export type ScheduleMode = (typeof SCHEDULE_MODES)[number];

// ── Objective priority ───────────────────────────────────────────────────────

export const OBJECTIVE_PRIORITIES = ["critical", "high", "normal", "low"] as const;
export type ObjectivePriority = (typeof OBJECTIVE_PRIORITIES)[number];

// ── Sub-schemas ──────────────────────────────────────────────────────────────

const WorkerIdentitySchema = z.object({
  /** What entity this worker represents (e.g. "Pushkar"). */
  represents: z.string().min(1),
  /** Role title (e.g. "Professional Opportunity Operator"). */
  role: z.string().min(1),
  /** Freeform description of the worker's identity. */
  description: z.string().optional(),
});

const WorkerObjectiveSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  priority: z.enum(OBJECTIVE_PRIORITIES).default("normal"),
});

const WorkerPermissionsSchema = z.object({
  /** Capability identifiers the worker may use freely. */
  allowed: z.array(z.string()).default([]),
  /** Capability identifiers that require HITL approval before execution. */
  approvalRequired: z.array(z.string()).default([]),
  /** Capability identifiers explicitly denied to this worker. */
  denied: z.array(z.string()).default([]),
});

const WorkerContextRefsSchema = z.object({
  /** Named memory scopes the worker may query (e.g. "personal_rag", "turicks_brain"). */
  memoryScopes: z.array(z.string()).default([]),
  /** Opaque reference strings the runtime can use to retrieve further context. */
  contextRefs: z.array(z.string()).default([]),
});

const WorkerRuntimeSchema = z.object({
  /** Runtime provider identifier (e.g. "antigravity", "claude_code", "openclaw"). */
  provider: z.string().min(1),
  /** Opaque reference to runtime-specific configuration. */
  configRef: z.string().optional(),
});

const WorkerScheduleSchema = z.object({
  mode: z.enum(SCHEDULE_MODES).default("on_demand"),
  /** Cron expression for scheduled mode. */
  cron: z.string().optional(),
});

// ── Full contract schema ─────────────────────────────────────────────────────

export const WorkerContractSchema = z.object({
  worker: z.object({
    id: z.string().min(1).regex(/^[a-z][a-z0-9_]*$/, "worker id: lowercase alphanumerics and underscores"),
    name: z.string().min(1),
    contractVersion: z.string().min(1).regex(/^\d+\.\d+\.\d+$/, "semver format: x.y.z"),
  }),

  identity: WorkerIdentitySchema,
  purpose: z.string().min(1),

  responsibilities: z.array(z.string().min(1)).min(1),
  objectives: z.array(WorkerObjectiveSchema).default([]),
  constraints: z.array(z.string()).default([]),

  capabilities: z.array(z.string().min(1)).min(1),
  permissions: WorkerPermissionsSchema.default({}),

  context: WorkerContextRefsSchema.default({}),
  runtime: WorkerRuntimeSchema,
  schedule: WorkerScheduleSchema.default({}),

  lifecycle: z.object({
    status: z.enum(WORKER_STATUSES).default("CREATED"),
  }).default({}),
});

export type WorkerContract = z.infer<typeof WorkerContractSchema>;
export type WorkerIdentity = z.infer<typeof WorkerIdentitySchema>;
export type WorkerObjective = z.infer<typeof WorkerObjectiveSchema>;
export type WorkerPermissions = z.infer<typeof WorkerPermissionsSchema>;
export type WorkerContextRefs = z.infer<typeof WorkerContextRefsSchema>;
export type WorkerRuntime = z.infer<typeof WorkerRuntimeSchema>;
export type WorkerSchedule = z.infer<typeof WorkerScheduleSchema>;
