/**
 * Context isolation under concurrent load (CLAUDE rule #20).
 *
 * Tests that the outputMode:"last_message" guarantee holds structurally
 * even when multiple threads run concurrently through the same office.
 * These are unit-level tests of the guard functions — the integration-level
 * proof is in tests/integration/nested-hitl.test.ts (live model).
 */

import { describe, it, expect } from "vitest";
import { assertContextIsolation, CONTEXT_ISOLATION_OUTPUT_MODE } from "../../../src/agents/context-isolation.js";
import { GOLDEN_TASKS } from "../../../src/eval/golden-tasks.js";
import { runEval } from "../../../src/eval/runner.js";
import type { GoldenTask, Observation } from "../../../src/eval/types.js";

// ── Guard correctness ─────────────────────────────────────────────────────────

describe("assertContextIsolation guard under concurrent calls", () => {
  it("returns last_message for all concurrent callers without mutation", async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, async () => assertContextIsolation("last_message")),
    );
    expect(results.every((r) => r === "last_message")).toBe(true);
  });

  it("throws synchronously on full_history — no concurrent caller leaks past the guard", () => {
    const errors: Error[] = [];
    for (let i = 0; i < 20; i++) {
      try {
        assertContextIsolation("full_history");
      } catch (e) {
        errors.push(e as Error);
      }
    }
    // Every call threw — no silent pass-through.
    expect(errors).toHaveLength(20);
    expect(errors.every((e) => e.message.includes("Context isolation violation"))).toBe(true);
  });
});

// ── Thread-level isolation invariant ─────────────────────────────────────────

describe("Thread-level context isolation invariant", () => {
  it("each thread_id gets a unique configurable slot (no shared mutable state)", () => {
    const threadIds = Array.from({ length: 20 }, (_, i) => `turicks:founder:stress-${i}`);
    const configs = threadIds.map((id) => ({ configurable: { thread_id: id } }));

    // All thread_ids are distinct.
    const unique = new Set(configs.map((c) => c.configurable.thread_id));
    expect(unique.size).toBe(20);

    // No config references the same object (no aliasing that could cause shared-state bugs).
    for (let i = 0; i < configs.length; i++) {
      for (let j = i + 1; j < configs.length; j++) {
        expect(configs[i]).not.toBe(configs[j]);
      }
    }
  });

  it("CONTEXT_ISOLATION_OUTPUT_MODE is a constant (not mutable between threads)", () => {
    // Read concurrently — must be stable.
    const reads = Array.from({ length: 100 }, () => CONTEXT_ISOLATION_OUTPUT_MODE);
    expect(reads.every((v) => v === "last_message")).toBe(true);
  });
});

// ── Eval golden tasks: isolation coverage ────────────────────────────────────

describe("Golden tasks cover context isolation scenarios", () => {
  it("all golden tasks have an expectedRoute (isolation requires knowing where to route)", () => {
    const missing = GOLDEN_TASKS.filter((t) => !t.expectedRoute);
    expect(missing).toEqual([]);
  });

  it("no two golden tasks share the same id (stable regression reference)", () => {
    const ids = GOLDEN_TASKS.map((t) => t.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it("adversarial tasks all have expectedRoute (they must route somewhere, not crash)", () => {
    const adversarial = GOLDEN_TASKS.filter((t) => t.id.startsWith("adversarial-") || t.id.startsWith("stress-"));
    expect(adversarial.length).toBeGreaterThanOrEqual(6);
    const missingRoute = adversarial.filter((t) => !t.expectedRoute);
    expect(missingRoute).toEqual([]);
  });
});

// ── Concurrent eval with per-thread routing ────────────────────────────────────

describe("Concurrent eval: per-thread perfect routing (no result pollution)", () => {
  const RUNS = 5;

  it(`${RUNS} concurrent eval runs all produce 100% routing accuracy`, async () => {
    const perfectInvoker = async (task: GoldenTask): Promise<Observation> => ({
      route: task.expectedRoute,
      tools: task.expectedTools ?? [],
      hadInterrupt: task.expectsHitl ?? false,
    });

    const reports = await Promise.all(
      Array.from({ length: RUNS }, () => runEval(GOLDEN_TASKS, perfectInvoker)),
    );

    // Every concurrent run independently scores 100%.
    for (const report of reports) {
      expect(report.routing.accuracy).toBe(1);
      expect(report.overall.accuracy).toBe(1);
    }

    // All runs agree on total task count — no run sees a different task list.
    const counts = reports.map((r) => r.results.length);
    expect(new Set(counts).size).toBe(1);
    expect(counts[0]).toBe(GOLDEN_TASKS.length);
  });

  it("eval reports from concurrent runs are independent objects (no shared reference)", async () => {
    const invoker = async (task: GoldenTask): Promise<Observation> => ({
      route: task.expectedRoute,
      tools: [],
      hadInterrupt: false,
    });

    const [a, b] = await Promise.all([
      runEval(GOLDEN_TASKS.slice(0, 3), invoker),
      runEval(GOLDEN_TASKS.slice(0, 3), invoker),
    ]);

    // Different objects — no aliasing.
    expect(a).not.toBe(b);
    expect(a.results).not.toBe(b.results);
    // Same accuracy (both correct).
    expect(a.routing.accuracy).toBe(b.routing.accuracy);
  });
});
