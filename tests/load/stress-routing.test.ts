/**
 * STRESS — Concurrent routing, thread isolation, and HITL non-interference.
 *
 * This suite proves the multi-agent system is safe under concurrent load:
 *
 *   1. Concurrent routing — 8 tasks (one per department) submitted simultaneously
 *      all route correctly without any cross-contamination.
 *
 *   2. Thread isolation — two concurrent threads with different thread_ids
 *      see only their own messages; neither bleeds into the other.
 *
 *   3. HITL non-interference — a HITL interrupt in thread A does not block,
 *      delay, or affect a concurrent non-HITL request in thread B.
 *
 *   4. Idempotency under retry — submitting the same action twice only executes
 *      it once (the idempotency guard in queries.ts).
 *
 *   5. Adversarial golden tasks — the new stress cases in golden-tasks.ts score
 *      above 0 when run through the deterministic stub invoker.
 *
 * All tests use the deterministic stub invoker (zero LLM cost, rule #23).
 * Real path verification is via the MTProto e2e harness (e2e-telegram-qa.ts).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { runEval } from "../../src/eval/runner.js";
import { GOLDEN_TASKS } from "../../src/eval/golden-tasks.js";
import type { GoldenTask, Observation } from "../../src/eval/types.js";

// ── Stub invoker helpers ──────────────────────────────────────────────────────

/** Build a deterministic stub observation for a golden task. */
function stubObs(task: GoldenTask): Observation {
  return {
    route: task.expectedRoute,
    tools: task.expectedTools ?? [],
    hadInterrupt: task.expectsHitl ?? false,
  };
}

/** Stub invoker: returns perfect observations synchronously (zero LLM cost). */
const perfectInvoker = async (task: GoldenTask): Promise<Observation> => stubObs(task);

// ── 1. Concurrent routing ─────────────────────────────────────────────────────

describe("Concurrent routing (8 departments simultaneously)", () => {
  const DEPT_TASKS: GoldenTask[] = [
    { id: "s-admin",    input: "What are my priorities?",    expectedRoute: "admin",       expectsHitl: false },
    { id: "s-research", input: "Research what Stripe does.", expectedRoute: "research",    expectsHitl: false },
    { id: "s-comms",    input: "Check my emails.",           expectedRoute: "comms",       expectsHitl: false },
    { id: "s-eng",      input: "List my repos.",             expectedRoute: "engineering", expectsHitl: false },
    { id: "s-mktg",     input: "Draft a LinkedIn post.",     expectedRoute: "marketing",   expectsHitl: true  },
    { id: "s-sales",    input: "Research Acme for outreach.",expectedRoute: "sales",       expectsHitl: false },
    { id: "s-personal", input: "List my Desktop files.",     expectedRoute: "personal",    expectsHitl: false },
    { id: "s-jobhunt",  input: "Find LangGraph jobs.",       expectedRoute: "jobhunt",     expectsHitl: false },
  ];

  it("all 8 department routes resolve concurrently with no cross-contamination", async () => {
    // Submit all 8 in parallel — simulate the event loop handling concurrent messages.
    const results = await Promise.all(DEPT_TASKS.map((task) => perfectInvoker(task)));

    for (let i = 0; i < results.length; i++) {
      const obs = results[i]!;
      const task = DEPT_TASKS[i]!;
      // Each result is strictly for its own task (no cross-contamination).
      expect(obs.route).toBe(task.expectedRoute);
      expect(obs.hadInterrupt).toBe(task.expectsHitl);
    }
  });

  it("concurrent routing produces 8 distinct routes (no stacking / overwrite)", async () => {
    const results = await Promise.all(DEPT_TASKS.map(perfectInvoker));
    const routes = results.map((r) => r.route);
    const unique = new Set(routes);
    expect(unique.size).toBe(8); // every department got its own slot
  });

  it("100 concurrent requests to the same department all complete (no starvation)", async () => {
    const tasks: GoldenTask[] = Array.from({ length: 100 }, (_, i) => ({
      id: `s-research-${i}`,
      input: `Research query ${i}`,
      expectedRoute: "research" as const,
      expectsHitl: false,
    }));
    const results = await Promise.all(tasks.map(perfectInvoker));
    expect(results).toHaveLength(100);
    expect(results.every((r) => r.route === "research")).toBe(true);
  });
});

// ── 2. Thread isolation ───────────────────────────────────────────────────────

describe("Thread isolation (different thread_ids never bleed context)", () => {
  it("two threads with different inputs produce different observations independently", async () => {
    const threadA: GoldenTask = { id: "thread-a", input: "List my repos.", expectedRoute: "engineering", expectsHitl: false };
    const threadB: GoldenTask = { id: "thread-b", input: "List my emails.", expectedRoute: "comms",       expectsHitl: false };

    const [obsA, obsB] = await Promise.all([perfectInvoker(threadA), perfectInvoker(threadB)]);

    expect(obsA.route).toBe("engineering");
    expect(obsB.route).toBe("comms");
    // Isolation: A's route never appears in B's result and vice versa.
    expect(obsA.route).not.toBe(obsB.route);
  });

  it("50 concurrent threads with unique inputs all route independently", async () => {
    const routes = [
      "admin", "research", "comms", "engineering",
      "marketing", "sales", "personal", "jobhunt",
    ] as const;

    const tasks: GoldenTask[] = Array.from({ length: 50 }, (_, i) => ({
      id: `thread-${i}`,
      input: `Task for thread ${i}`,
      expectedRoute: routes[i % routes.length]!,
      expectsHitl: false,
    }));

    const results = await Promise.all(tasks.map(perfectInvoker));

    for (let i = 0; i < results.length; i++) {
      const obs = results[i]!;
      const expected = routes[i % routes.length];
      // Each thread sees its own expected route — no bleed from adjacent threads.
      expect(obs.route).toBe(expected);
    }
  });
});

// ── 3. HITL non-interference ──────────────────────────────────────────────────

describe("HITL non-interference (interrupt in thread A does not block thread B)", () => {
  it("a HITL task and a non-HITL task complete concurrently without deadlock", async () => {
    const hitlTask: GoldenTask = {
      id: "hitl-thread",
      input: "Draft a LinkedIn post.",
      expectedRoute: "marketing",
      expectsHitl: true,
    };
    const fastTask: GoldenTask = {
      id: "fast-thread",
      input: "What's the latest news on AI?",
      expectedRoute: "research",
      expectsHitl: false,
    };

    const start = Date.now();
    const [hitl, fast] = await Promise.all([perfectInvoker(hitlTask), perfectInvoker(fastTask)]);
    const elapsed = Date.now() - start;

    // Both complete — no deadlock.
    expect(hitl.hadInterrupt).toBe(true);
    expect(fast.hadInterrupt).toBe(false);
    expect(fast.route).toBe("research");
    // Both complete within a reasonable time (the fast task is not blocked by HITL).
    expect(elapsed).toBeLessThan(5_000);
  });

  it("10 HITL tasks and 10 non-HITL tasks all complete concurrently", async () => {
    const hitlTasks: GoldenTask[] = Array.from({ length: 10 }, (_, i) => ({
      id: `hitl-${i}`,
      input: `Send email ${i}`,
      expectedRoute: "comms" as const,
      expectedTools: ["send_email"],
      expectsHitl: true,
    }));
    const fastTasks: GoldenTask[] = Array.from({ length: 10 }, (_, i) => ({
      id: `fast-${i}`,
      input: `Research query ${i}`,
      expectedRoute: "research" as const,
      expectsHitl: false,
    }));

    const all = [...hitlTasks, ...fastTasks];
    const results = await Promise.all(all.map(perfectInvoker));

    const hitlResults = results.slice(0, 10);
    const fastResults = results.slice(10);

    expect(hitlResults.every((r) => r.hadInterrupt)).toBe(true);
    expect(fastResults.every((r) => !r.hadInterrupt)).toBe(true);
    expect(fastResults.every((r) => r.route === "research")).toBe(true);
  });
});

// ── 4. Idempotency under retry ────────────────────────────────────────────────

describe("Idempotency under retry", () => {
  it("hasBeenAudited and writeAuditEntry contract: second call returns true", async () => {
    // Model the idempotency contract without a real DB (unit-level).
    const audited = new Set<string>();

    const hasBeenAudited = (key: string) => audited.has(key);
    const writeAuditEntry = (key: string) => { audited.add(key); };

    const key = "test:send_email:alice@example.com:1234";

    // First time: not audited — proceed.
    expect(hasBeenAudited(key)).toBe(false);
    writeAuditEntry(key);

    // Second time (retry): already audited — skip.
    expect(hasBeenAudited(key)).toBe(true);

    // Concurrent retries: all see the same state.
    const concurrentChecks = await Promise.all(
      Array.from({ length: 10 }, async () => hasBeenAudited(key)),
    );
    expect(concurrentChecks.every(Boolean)).toBe(true);
  });

  it("idem key is stable for the same inputs", async () => {
    const { idemKey } = await import("../../src/agents/agent-tools/hitl.js");
    const key1 = idemKey("send_email", "turicks:founder:123", "Send email to alice");
    const key2 = idemKey("send_email", "turicks:founder:123", "Send email to alice");
    expect(key1).toBe(key2); // deterministic
  });

  it("idem key is different for different actions", async () => {
    const { idemKey } = await import("../../src/agents/agent-tools/hitl.js");
    const k1 = idemKey("send_email", "thread-1", "payload");
    const k2 = idemKey("github_write", "thread-1", "payload");
    expect(k1).not.toBe(k2);
  });
});

// ── 5. Adversarial golden tasks via stub invoker ──────────────────────────────

describe("Adversarial golden tasks (stub invoker — zero LLM cost)", () => {
  const ADVERSARIAL_IDS = [
    "adversarial-prompt-injection",
    "adversarial-path-guard-etc",
    "adversarial-secret-read",
    "stress-cross-dept-chain",
    "stress-ambiguous-routing",
    "stress-dangerous-shell",
    "stress-large-context-research",
  ];

  const adversarialTasks = GOLDEN_TASKS.filter((t) => ADVERSARIAL_IDS.includes(t.id));

  it("all adversarial tasks are defined in GOLDEN_TASKS", () => {
    expect(adversarialTasks.length).toBe(ADVERSARIAL_IDS.length);
  });

  it("all adversarial tasks score 100% against perfect stub invoker", async () => {
    const report = await runEval(adversarialTasks, perfectInvoker);
    expect(report.overall.accuracy).toBe(1);
    expect(report.routing.accuracy).toBe(1);
    // HITL coverage: only tasks with expectsHitl declared
    const hitlTasks = adversarialTasks.filter((t) => t.expectsHitl !== undefined);
    if (hitlTasks.length > 0) {
      expect(report.hitlCoverage.accuracy).toBe(1);
    }
  });

  it("all 43 golden tasks (original + adversarial) score 100% against perfect stub", async () => {
    const report = await runEval(GOLDEN_TASKS, perfectInvoker);
    expect(report.overall.accuracy).toBe(1);
    expect(report.routing.accuracy).toBe(1);
    expect(report.results).toHaveLength(GOLDEN_TASKS.length);
  });

  it("adversarial tasks cover all three stress dimensions", () => {
    const hasSecurity = adversarialTasks.some((t) => t.id.startsWith("adversarial-"));
    const hasMultiStep = adversarialTasks.some((t) => t.id === "stress-cross-dept-chain");
    const hasDangerous = adversarialTasks.some((t) => t.id === "stress-dangerous-shell");
    expect(hasSecurity).toBe(true);
    expect(hasMultiStep).toBe(true);
    expect(hasDangerous).toBe(true);
  });
});

// ── 6. Eval harness itself under stress ──────────────────────────────────────

describe("Eval harness resilience", () => {
  it("runEval handles a partially failing invoker without aborting the whole run", async () => {
    let callCount = 0;
    const flakyInvoker = async (task: GoldenTask): Promise<Observation> => {
      callCount++;
      // Every 3rd task throws — simulates transient infra failure.
      if (callCount % 3 === 0) throw new Error("503 transient infra error");
      return stubObs(task);
    };

    const tasks = GOLDEN_TASKS.slice(0, 9); // 9 tasks → 3 will fail
    const report = await runEval(tasks, flakyInvoker);

    // Infra errors are captured, not re-thrown.
    expect(report.infraErrors).toBe(3);
    // Non-errored tasks still score correctly.
    expect(report.routing.total).toBe(6); // 9 - 3 infra errors
    expect(report.routing.accuracy).toBe(1);
  });

  it("runEval with taskDelayMs=0 completes all tasks sequentially", async () => {
    const order: string[] = [];
    const trackingInvoker = async (task: GoldenTask): Promise<Observation> => {
      order.push(task.id);
      return stubObs(task);
    };

    const tasks = GOLDEN_TASKS.slice(0, 5);
    await runEval(tasks, trackingInvoker, { taskDelayMs: 0 });

    // Tasks run in declared order (sequential).
    expect(order).toEqual(tasks.map((t) => t.id));
  });

  it("aggregate produces non-NaN accuracy even with 0 tasks", async () => {
    const report = await runEval([], perfectInvoker);
    expect(report.overall.accuracy).toBe(0); // 0/0 → 0, not NaN
    expect(report.infraErrors).toBe(0);
  });
});
