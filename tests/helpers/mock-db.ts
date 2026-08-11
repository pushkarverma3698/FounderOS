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
  };
}

// ── Drizzle client mock ───────────────────────────────────────────────────────

interface MockQueryChain {
  from: () => MockQueryChain;
  where: () => MockQueryChain;
  orderBy: () => MockQueryChain;
  limit: () => MockQueryChain;
  then: (
    onOk: (rows: readonly unknown[]) => unknown,
    onErr?: (err: unknown) => unknown,
  ) => Promise<unknown>;
}

/**
 * Stub for `src/db/client.ts`'s `getDb()`.
 *
 * Most tools reach the database through `src/db/queries.ts` and are mocked with
 * `mockQueriesModule` above. A few (job_state, ops_state) build drizzle queries
 * inline instead, so they need the client itself stubbed or their "unit" tests
 * open a real connection — which fails in CI, because ci.yml runs no Postgres
 * service.
 *
 * Every such query is a `.select(...).from(...)...` chain awaited exactly once,
 * so each chain method returns itself and the chain is thenable. Each test sets
 * its own queue with `setQueryResults(...)` IN CALL ORDER, so tests do not
 * inherit each other's leftovers; a query past the end of the queue resolves
 * to `[]`.
 *
 * Usage — note the deferred import, which is what lets the lazy `vi.mock`
 * factory see `stub`:
 *
 *   const stub = createDrizzleClientStub();
 *   vi.mock("../../../src/db/client.js", () => ({ getDb: stub.getDb }));
 *   const { queryOpsState } = await import("../../../src/tools/ops-state.js");
 */
export function createDrizzleClientStub() {
  let queue: (readonly unknown[])[] = [];

  const setQueryResults = (...results: (readonly unknown[])[]): void => {
    queue = [...results];
  };

  const getDb = vi.fn(() => ({
    select: (): MockQueryChain => {
      const rows = queue.shift() ?? [];
      const chain: MockQueryChain = {
        from: () => chain,
        where: () => chain,
        orderBy: () => chain,
        limit: () => chain,
        then: (onOk, onErr) => Promise.resolve(rows).then(onOk, onErr),
      };
      return chain;
    },
  }));

  return { getDb, setQueryResults };
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
  };
}
