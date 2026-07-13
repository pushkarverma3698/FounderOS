/**
 * Failure-lesson memory — unit tests for the pure pieces (signature
 * normalization, lesson message) and the dispatch decorator's two hooks
 * (inject on retry, record on retry-success), with a fake LessonStore.
 */

import { describe, it, expect, vi } from "vitest";
import { HumanMessage } from "@langchain/core/messages";
import {
  normalizeFailureSignature,
  lessonMessage,
  makeLessonDispatch,
  SIGNATURE_MAX_CHARS,
  type FailureLesson,
  type LessonStore,
} from "../../../src/kernel/lessons.js";
import type { KernelStateType } from "../../../src/kernel/state.js";
import type { StepResult } from "../../../src/kernel/contracts.js";

// ── normalizeFailureSignature ─────────────────────────────────────────────────

describe("normalizeFailureSignature", () => {
  it("maps the same failure mode with different volatile parts to ONE signature", () => {
    const a = normalizeFailureSignature(
      'LinkedIn analytics returned 400 for request 3f9e0d1c-aaaa-bbbb-cccc-123456789012: range 120 days exceeds max 90 — see https://api.linkedin.com/v2/doc?id=9912',
    );
    const b = normalizeFailureSignature(
      'LinkedIn analytics returned 400 for request 11111111-2222-3333-4444-555555555555: range 365 days exceeds max 90 — see https://api.linkedin.com/v2/doc?id=1',
    );
    expect(a).toBe(b);
    expect(a).toContain("<uuid>");
    expect(a).toContain("<n>");
    expect(a).toContain("<url>");
  });

  it("keeps genuinely different failures distinct", () => {
    expect(normalizeFailureSignature("Output does not satisfy draft.email — to: invalid email")).not.toBe(
      normalizeFailureSignature("Apify quota exhausted"),
    );
  });

  it("collapses emails and long hex hashes, caps length, and is total on junk", () => {
    const sig = normalizeFailureSignature(
      `Send to sam@x.dev failed, key deadbeefdeadbeefdeadbeefdeadbeef: ${"x".repeat(500)}`,
    );
    expect(sig).toContain("<email>");
    expect(sig).toContain("<hash>");
    expect(sig.length).toBeLessThanOrEqual(SIGNATURE_MAX_CHARS);
    expect(normalizeFailureSignature("")).toBe("");
  });
});

// ── fixtures ──────────────────────────────────────────────────────────────────

const STEP = {
  step_id: "s1",
  worker: "research",
  objective: "Find the latest LangGraph news",
  inputs: {},
  expected: { kind: "data", schema_ref: "research.findings" },
  constraints: { max_tool_calls: 2, hitl_required: false },
} as const;

const FAILED_RESULT: StepResult = {
  status: "failed",
  step_id: "s1",
  failure: {
    step_id: "s1",
    stage: "validation",
    component: "research",
    message: "Output does not satisfy research.findings — summary: Required",
    retryable: true,
  },
};

const OK_RESULT: StepResult = {
  status: "ok",
  step_id: "s1",
  output: { summary: "fixed", sources: [] },
  tool_receipts: [
    { tool: "search_web", args_hash: "a".repeat(64), result_digest: "b".repeat(64), ok: true, at: new Date().toISOString() },
    { tool: "scrape_url", args_hash: "c".repeat(64), result_digest: "d".repeat(64), ok: false, at: new Date().toISOString() },
  ],
};

function stateWith(over: Partial<KernelStateType>): KernelStateType {
  return {
    turn: { id: "t1", chat_id: "1", received_at: "", raw_input: "x" },
    mission: {
      goal: "g",
      status: "executing",
      plan: { schema_version: 1, goal: "g", steps: [STEP] },
      cursor: 0,
    },
    results: [],
    attempts: {},
    failure: null,
    scratch: [],
    step_receipts: [],
    reply: "",
    lesson_candidate: null,
    last_turn: null,
    history: [],
    ...over,
  } as unknown as KernelStateType;
}

const LESSON: FailureLesson = {
  worker: "research",
  signature: normalizeFailureSignature(FAILED_RESULT.status === "failed" ? FAILED_RESULT.failure.message : ""),
  component: "research",
  objective: "Find the latest LangGraph news",
  resolved_with_tools: ["search_web"],
  times_seen: 3,
  last_resolved_at: "2026-07-10T00:00:00.000Z",
};

function fakeStore(lesson: FailureLesson | null = null): LessonStore & { record: ReturnType<typeof vi.fn>; lookup: ReturnType<typeof vi.fn> } {
  return {
    lookup: vi.fn(async () => lesson),
    record: vi.fn(async () => {}),
  };
}

// ── makeLessonDispatch ────────────────────────────────────────────────────────

describe("makeLessonDispatch", () => {
  it("without a store, behaves exactly like the pure dispatch", async () => {
    const node = makeLessonDispatch(undefined);
    const update = await node(stateWith({ results: [FAILED_RESULT] }));
    expect(update.mission).toMatchObject({ status: "executing", cursor: 0 });
    expect(update.lesson_candidate).toBeUndefined(); // untouched channel
  });

  it("on a retry with a KNOWN lesson: injects the lesson message after the retry instruction and stashes the candidate", async () => {
    const store = fakeStore(LESSON);
    const node = makeLessonDispatch(store);

    const update = await node(stateWith({ results: [FAILED_RESULT] }));

    expect(store.lookup).toHaveBeenCalledWith("research", LESSON.signature);
    const scratch = (update.scratch as { set: HumanMessage[] }).set;
    expect(scratch).toHaveLength(3); // envelope + RETRY + lesson
    const text = String(scratch[2]!.content);
    expect(text).toContain("KNOWN FAILURE PATTERN (seen 3×");
    expect(text).toContain("search_web");
    expect(update.lesson_candidate).toMatchObject({ step_id: "s1", worker: "research", signature: LESSON.signature });
  });

  it("on a retry with NO lesson: scratch stays envelope + retry only, candidate still stashed", async () => {
    const store = fakeStore(null);
    const node = makeLessonDispatch(store);

    const update = await node(stateWith({ results: [FAILED_RESULT] }));

    const scratch = (update.scratch as { set: HumanMessage[] }).set;
    expect(scratch).toHaveLength(2);
    expect(update.lesson_candidate).toMatchObject({ step_id: "s1" });
  });

  it("records the lesson when the stashed retry settles OK — only successful receipts, deduped", async () => {
    const store = fakeStore();
    const node = makeLessonDispatch(store);
    const candidate = {
      step_id: "s1",
      worker: "research",
      signature: LESSON.signature,
      component: "research",
      objective: STEP.objective,
    };

    const update = await node(stateWith({ results: [OK_RESULT], lesson_candidate: candidate }));

    expect(store.record).toHaveBeenCalledTimes(1);
    expect(store.record).toHaveBeenCalledWith({
      worker: "research",
      signature: LESSON.signature,
      component: "research",
      objective: STEP.objective,
      resolved_with_tools: ["search_web"], // the failed scrape_url receipt is excluded
    });
    expect(update.lesson_candidate).toBeNull();
  });

  it("discards the candidate WITHOUT recording when the retry also failed (terminal)", async () => {
    const store = fakeStore();
    const node = makeLessonDispatch(store);
    const candidate = { step_id: "s1", worker: "research", signature: "sig", component: "c", objective: "o" };
    // attempts exhausted → dispatch terminates with the failure
    const update = await node(
      stateWith({ results: [FAILED_RESULT], attempts: { s1: 2 }, lesson_candidate: candidate }),
    );

    expect(store.record).not.toHaveBeenCalled();
    expect(update.lesson_candidate).toBeNull();
    expect(update.mission).toMatchObject({ status: "failed" });
  });

  it("a throwing store never breaks the turn — retry proceeds, candidate settles", async () => {
    const store: LessonStore = {
      lookup: async () => {
        throw new Error("postgres down");
      },
      record: async () => {
        throw new Error("postgres down");
      },
    };
    const node = makeLessonDispatch(store);
    const candidate = { step_id: "s1", worker: "research", signature: "sig", component: "c", objective: "o" };

    const retryUpdate = await node(stateWith({ results: [FAILED_RESULT] }));
    expect((retryUpdate.scratch as { set: unknown[] }).set).toHaveLength(2); // no lesson, no crash
    expect(retryUpdate.mission).toMatchObject({ status: "executing" });

    const recordUpdate = await node(stateWith({ results: [OK_RESULT], lesson_candidate: candidate }));
    expect(recordUpdate.lesson_candidate).toBeNull();
    expect(recordUpdate.mission).toMatchObject({ status: "synthesizing" }); // mission advanced normally
  });
});
