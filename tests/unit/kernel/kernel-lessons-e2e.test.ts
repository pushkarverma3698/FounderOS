/**
 * Failure-lesson memory E2E on the REAL graph (offline, $0 — kernel-e2e
 * recipe). Proves the Hermes learning loop end to end:
 *   Mission 1: a step fails validation once, the retry succeeds → the store
 *              holds a (worker, signature → tools) lesson recorded by code.
 *   Mission 2 (fresh thread, same store): the SAME failure occurs → the
 *              retry envelope the worker model actually receives contains the
 *              injected KNOWN FAILURE PATTERN message.
 * The engine measurably learns from failure across missions — deterministic,
 * with zero model involvement in what gets remembered.
 */

import { describe, it, expect } from "vitest";
import { MemorySaver } from "@langchain/langgraph";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import {
  buildKernel,
  KERNEL_SCHEMA_VERSION,
  normalizeFailureSignature,
  type FailureLesson,
  type KernelBindableModel,
  type KernelTool,
  type LessonStore,
  type WorkerSpec,
} from "../../../src/kernel/index.js";

class ScriptedModel implements KernelBindableModel {
  calls = 0;
  received: BaseMessage[][] = [];
  constructor(private script: Array<AIMessage | ((msgs: BaseMessage[]) => AIMessage)>) {}
  bindTools(): ScriptedModel {
    return this;
  }
  async invoke(messages: BaseMessage[]): Promise<AIMessage> {
    this.received.push(messages);
    const entry = this.script[this.calls];
    this.calls += 1;
    if (!entry) throw new Error(`ScriptedModel exhausted after ${this.calls - 1} calls`);
    return typeof entry === "function" ? entry(messages) : entry;
  }
}

const ai = (content: string) => new AIMessage(content);
const planJson = () =>
  JSON.stringify({
    type: "plan",
    plan: {
      schema_version: KERNEL_SCHEMA_VERSION,
      goal: "research goal",
      steps: [
        {
          step_id: "s1",
          worker: "research",
          objective: "Find the latest LangGraph news",
          inputs: {},
          expected: { kind: "data", schema_ref: "research.findings" },
          constraints: { max_tool_calls: 2, hitl_required: false },
        },
      ],
    },
  });

const searchTool: KernelTool = {
  name: "search_web",
  description: "search the web",
  invoke: async () => JSON.stringify({ success: true, data: [] }),
};
const workers: WorkerSpec[] = [
  { id: "research", description: "web research", prompt: "You are the research worker.", tools: [searchTool] },
];

/**
 * In-memory LessonStore — the exact contract kernel-boot's Postgres store
 * implements, including the split axes: `times_seen` bumps on EVERY
 * occurrence (recordOccurrence — the failure path, resolved or not),
 * `times_resolved` bumps only on an actual resolution (record).
 */
function memoryStore(): LessonStore & { rows: Map<string, FailureLesson> } {
  const rows = new Map<string, FailureLesson>();
  return {
    rows,
    async lookup(worker, signature) {
      return rows.get(`${worker}:${signature}`) ?? null;
    },
    async recordOccurrence(occurrence) {
      const key = `${occurrence.worker}:${occurrence.signature}`;
      const prev = rows.get(key);
      rows.set(key, {
        worker: occurrence.worker,
        signature: occurrence.signature,
        component: occurrence.component,
        objective: occurrence.objective,
        resolved_with_tools: prev?.resolved_with_tools ?? [],
        times_seen: (prev?.times_seen ?? 0) + 1,
        times_resolved: prev?.times_resolved ?? 0,
        last_resolved_at: prev?.last_resolved_at ?? "1970-01-01T00:00:00.000Z",
      });
    },
    async record(lesson) {
      const key = `${lesson.worker}:${lesson.signature}`;
      const prev = rows.get(key);
      rows.set(key, {
        ...lesson,
        times_seen: prev?.times_seen ?? 1,
        times_resolved: (prev?.times_resolved ?? 0) + 1,
        last_resolved_at: "2026-07-12T00:00:00.000Z",
      });
    },
  };
}

// Worker script: attempt 1 finalizes INVALID output ({} fails research.findings),
// attempt 2 (the retry) finalizes valid output. Same script both missions.
const failThenSucceedWorker = () =>
  new ScriptedModel([
    ai(JSON.stringify({})),
    ai(JSON.stringify({ summary: "LangGraph 1.4 released", sources: [] })),
  ]);

function kernelWith(store: LessonStore, worker: ScriptedModel) {
  return buildKernel({
    plannerModel: new ScriptedModel([ai(planJson())]),
    workerModel: worker,
    synthesizerModel: new ScriptedModel([ai("Done.")]),
    workers,
    checkpointer: new MemorySaver(),
    lessons: store,
  });
}

const cfg = (thread: string) => ({ configurable: { thread_id: thread } });
const turn = (id: string) => ({
  turn: { id, chat_id: "1", received_at: new Date().toISOString(), raw_input: "research LangGraph news" },
});

describe("failure-lesson learning loop E2E (real graph)", () => {
  it("mission 1 records the lesson; mission 2's retry envelope carries it — the engine learned", async () => {
    const store = memoryStore();

    // ── Mission 1: fail once, retry succeeds → lesson recorded by code ──────
    const w1 = failThenSucceedWorker();
    const r1 = await kernelWith(store, w1).invoke(turn("t1"), cfg("m1"));
    expect(r1.mission.status).toBe("done");
    expect(r1.attempts["s1"]).toBe(2); // one failure + one successful retry

    expect(store.rows.size).toBe(1);
    const lesson = [...store.rows.values()][0]!;
    expect(lesson.worker).toBe("research");
    expect(lesson.signature).toBe(
      normalizeFailureSignature("Output does not satisfy \"research.findings\" — summary: Required"),
    );
    // One failure (occurrence) + one successful retry (resolution).
    expect(lesson.times_seen).toBe(1);
    expect(lesson.times_resolved).toBe(1);

    // Mission 1 itself saw NO lesson (store was empty at its retry).
    const m1RetryMsgs = w1.received[1]!.map((m) => String(m.content)).join("\n");
    expect(m1RetryMsgs).not.toContain("KNOWN FAILURE PATTERN");

    // ── Mission 2: same failure on a FRESH thread → lesson injected ─────────
    const w2 = failThenSucceedWorker();
    const r2 = await kernelWith(store, w2).invoke(turn("t2"), cfg("m2"));
    expect(r2.mission.status).toBe("done");

    const m2RetryMsgs = w2.received[1]!.map((m) => String(m.content)).join("\n");
    expect(m2RetryMsgs).toContain("RETRY 1 of 2"); // the normal (non-final) retry instruction…
    // Lesson lookup happens BEFORE this occurrence is recorded, so the
    // injected message reports mission 1's history only ("seen 1×" — the
    // resolution mission 1 recorded), not mission 2's own in-flight failure.
    expect(m2RetryMsgs).toContain("KNOWN FAILURE PATTERN (seen 1×");
    expect(m2RetryMsgs).toContain("Find the latest LangGraph news");

    // Mission 2 adds a second occurrence AND a second resolution.
    const finalLesson = [...store.rows.values()][0]!;
    expect(finalLesson.times_seen).toBe(2);
    expect(finalLesson.times_resolved).toBe(2);
  });

  it("a mission with no failures records nothing and injects nothing", async () => {
    const store = memoryStore();
    const w = new ScriptedModel([ai(JSON.stringify({ summary: "clean run", sources: [] }))]);
    const res = await kernelWith(store, w).invoke(turn("t1"), cfg("clean"));

    expect(res.mission.status).toBe("done");
    expect(store.rows.size).toBe(0);
    expect(w.calls).toBe(1);
  });
});
