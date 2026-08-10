/**
 * Mock DB helpers for unit + integration tests.
 *
 * Usage:
 *   vi.mock("../../src/db/queries.js", () => mockQueriesModule())
 *   // or for "DB is down" scenarios:
 *   vi.mock("../../src/db/queries.js", () => mockQueriesDownModule())
 *
 * Design:
 *   Mirrors the real public API of src/db/queries.ts exactly.
 *   All mocks default to success (resolved values).
 *   Each mock function is a vi.fn() so tests can spy on calls.
 */

import { vi } from "vitest";

// ── Standard DB Mock (works fine) ─────────────────────────────────────────────

/**
 * All DB queries succeed — returns sensible defaults.
 */
export function mockQueriesModule() {
  return {
    // Audit
    hasBeenAudited: vi.fn().mockResolvedValue(false),
    writeAuditEntry: vi.fn().mockResolvedValue(undefined),

    // Suppression
    isSuppressed: vi.fn().mockResolvedValue(false),
    addSuppression: vi.fn().mockResolvedValue(undefined),

    // LLM cost tracking
    logLlmCost: vi.fn().mockResolvedValue(undefined),
    getTodayCostUsd: vi.fn().mockResolvedValue(0),

    // HITL / interrupt registry
    createInterruptRecord: vi.fn().mockResolvedValue({ id: "test-interrupt-id" }),
    updateInterruptStatus: vi.fn().mockResolvedValue(undefined),
    getInterruptRecord: vi.fn().mockResolvedValue(null),
    getPendingInterrupts: vi.fn().mockResolvedValue([]),
    expireOldInterrupts: vi.fn().mockResolvedValue(0),

    // Lead pipeline
    createLead: vi.fn().mockResolvedValue({ id: "test-lead-id" }),
    updateLeadStage: vi.fn().mockResolvedValue(undefined),
    getLeadByUrl: vi.fn().mockResolvedValue(null),
    updateLeadIcpScore: vi.fn().mockResolvedValue(undefined),

    // Task outcomes (self-improvement)
    writeTaskOutcome: vi.fn().mockResolvedValue(undefined),
    getRecentOutcomes: vi.fn().mockResolvedValue([]),

    // Cross-dept signals
    publishDeptEvent: vi.fn().mockResolvedValue("mock-signal-id"),
    publishDeptEventWithAudit: vi.fn().mockResolvedValue({ signalId: "mock-signal-id" }),
    consumePendingEvents: vi.fn().mockResolvedValue([]),

    // G4: Daily outbound quota (Postgres-backed) — default 0 so tests pass under limit
    getDailyOutboundCount: vi.fn().mockResolvedValue(0),

    // State tools
    queryJobState: vi.fn().mockResolvedValue({ count: 0, total: 0, rows: [] }),
    queryOpsState: vi.fn().mockImplementation(async (args) => ({ count: 0, total: 0, scope: args.scope, rows: [] })),
  };
}

// ── DB-Down Mock ──────────────────────────────────────────────────────────────

/**
 * All DB queries throw — simulates database unavailability.
 * Tests that callers handle DB failures gracefully (fail-open patterns).
 */
export function mockQueriesDownModule() {
  const dbError = new Error("ECONNREFUSED — DB is down");
  (dbError as NodeJS.ErrnoException).code = "ECONNREFUSED";

  const throwDb = vi.fn().mockRejectedValue(dbError);

  return {
    hasBeenAudited: throwDb,
    writeAuditEntry: throwDb,
    isSuppressed: throwDb,
    addSuppression: throwDb,
    logLlmCost: throwDb,
    getTodayCostUsd: throwDb,
    createInterruptRecord: throwDb,
    updateInterruptStatus: throwDb,
    getInterruptRecord: throwDb,
    getPendingInterrupts: throwDb,
    expireOldInterrupts: throwDb,
    createLead: throwDb,
    updateLeadStage: throwDb,
    getLeadByUrl: throwDb,
    updateLeadIcpScore: throwDb,
    writeTaskOutcome: throwDb,
    getRecentOutcomes: throwDb,
    publishDeptEvent: throwDb,
    consumePendingEvents: throwDb,
    getDailyOutboundCount: throwDb,
    queryJobState: throwDb,
    queryOpsState: throwDb,
  };
}

// ── Slow DB Mock (for db-slow chaos tests) ────────────────────────────────────

/**
 * Returns a queries module where all calls resolve after `delayMs`.
 * Used to test per-operation timeout behaviour.
 */
export function mockSlowQueriesModule(delayMs: number) {
  const slow = <T>(value: T) =>
    vi.fn().mockImplementation(() => new Promise<T>((res) => setTimeout(() => res(value), delayMs)));

  return {
    hasBeenAudited: slow(false),
    writeAuditEntry: slow(undefined),
    isSuppressed: slow(false),
    addSuppression: slow(undefined),
    logLlmCost: slow(undefined),
    getTodayCostUsd: slow(0),
    createInterruptRecord: slow({ id: "test-interrupt-id" }),
    updateInterruptStatus: slow(undefined),
    getInterruptRecord: slow(null),
    getPendingInterrupts: slow([]),
    expireOldInterrupts: slow(0),
    createLead: slow({ id: "test-lead-id" }),
    updateLeadStage: slow(undefined),
    getLeadByUrl: slow(null),
    updateLeadIcpScore: slow(undefined),
    writeTaskOutcome: slow(undefined),
    getRecentOutcomes: slow([]),
    publishDeptEvent: slow(undefined),
    consumePendingEvents: slow([]),
    getDailyOutboundCount: slow(0),
    queryJobState: slow({ count: 0, total: 0, rows: [] }),
    queryOpsState: vi.fn().mockImplementation(async (args) => {
      await new Promise(r => setTimeout(r, delayMs));
      return { count: 0, total: 0, scope: args.scope, rows: [] };
    }),
  };
}
