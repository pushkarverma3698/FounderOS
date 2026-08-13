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
import { MAX_ATTEMPTS_PER_STEP } from "../../../src/kernel/supervisor.js";

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
    scratch: {},
    step_receipts: {},
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
  times_resolved: 2,
  last_resolved_at: "2026-07-10T00:00:00.000Z",
};

function fakeStore(
  lesson: FailureLesson | null = null,
): LessonStore & { record: ReturnType<typeof vi.fn>; lookup: ReturnType<typeof vi.fn>; recordOccurrence: ReturnType<typeof vi.fn> } {
  return {
    lookup: vi.fn(async () => lesson),
    record: vi.fn(async () => {}),
    recordOccurrence: vi.fn(async () => {}),
  };
}

/**
 * A store fake that actually implements the two-counter increment semantics
 * (mirrors src/db/queries.ts's recordFailureOccurrence / upsertFailureLesson
 * exactly: times_seen bumps ONLY on recordOccurrence, times_resolved bumps
 * ONLY on record) — used to prove the counters end up right end to end
 * through the dispatch decorator, not just that the right method was called.
 */
function statefulFakeStore(): LessonStore & {
  rows: Map<string, FailureLesson>;
  lookup: ReturnType<typeof vi.fn>;
  record: ReturnType<typeof vi.fn>;
  recordOccurrence: ReturnType<typeof vi.fn>;
} {
  const rows = new Map<string, FailureLesson>();
  const key = (worker: string, signature: string) => `${worker}:${signature}`;
  return {
    rows,
    lookup: vi.fn(async (worker: string, signature: string) => rows.get(key(worker, signature)) ?? null),
    recordOccurrence: vi.fn(async (occ: { worker: string; signature: string; component: string; objective: string }) => {
      const k = key(occ.worker, occ.signature);
      const prev = rows.get(k);
      rows.set(k, {
        worker: occ.worker,
        signature: occ.signature,
        component: occ.component,
        objective: occ.objective,
        resolved_with_tools: prev?.resolved_with_tools ?? [],
        times_seen: (prev?.times_seen ?? 0) + 1,
        times_resolved: prev?.times_resolved ?? 0,
        last_resolved_at: prev?.last_resolved_at ?? "1970-01-01T00:00:00.000Z",
      });
    }),
    record: vi.fn(async (lesson: Omit<FailureLesson, "times_seen" | "times_resolved" | "last_resolved_at">) => {
      const k = key(lesson.worker, lesson.signature);
      const prev = rows.get(k);
      rows.set(k, {
        ...lesson,
        times_seen: prev?.times_seen ?? 1,
        times_resolved: (prev?.times_resolved ?? 0) + 1,
        last_resolved_at: "2026-08-12T00:00:00.000Z",
      });
    }),
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
    const scratch = (update.scratch as Record<string, { set: HumanMessage[] }>)["s1"]!.set;
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

    const scratch = (update.scratch as Record<string, { set: HumanMessage[] }>)["s1"]!.set;
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
      stateWith({ results: [FAILED_RESULT], attempts: { s1: MAX_ATTEMPTS_PER_STEP }, lesson_candidate: candidate }),
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
      recordOccurrence: async () => {
        throw new Error("postgres down");
      },
    };
    const node = makeLessonDispatch(store);
    const candidate = { step_id: "s1", worker: "research", signature: "sig", component: "c", objective: "o" };

    const retryUpdate = await node(stateWith({ results: [FAILED_RESULT] }));
    expect((retryUpdate.scratch as Record<string, { set: unknown[] }>)["s1"]!.set).toHaveLength(2); // no lesson, no crash
    expect(retryUpdate.mission).toMatchObject({ status: "executing" }); // recordOccurrence's throw didn't break dispatch either

    const recordUpdate = await node(stateWith({ results: [OK_RESULT], lesson_candidate: candidate }));
    expect(recordUpdate.lesson_candidate).toBeNull();
    expect(recordUpdate.mission).toMatchObject({ status: "synthesizing" }); // mission advanced normally
  });

  // ── Occurrence tracking (times_seen vs times_resolved) ──────────────────────

  it("the same failure signature raised N times with zero successful retries writes ONE row: times_seen = N, times_resolved = 0", async () => {
    const store = statefulFakeStore();
    const node = makeLessonDispatch(store);
    const N = 4;

    // N independent "a retry is about to be dispatched for this signature"
    // events (Hook 2 firing), none of which ever settle ok.
    for (let i = 0; i < N; i++) {
      await node(stateWith({ results: [FAILED_RESULT] }));
    }

    expect(store.recordOccurrence).toHaveBeenCalledTimes(N);
    expect(store.record).not.toHaveBeenCalled();
    const row = store.rows.get(`research:${LESSON.signature}`);
    expect(row).toBeDefined();
    expect(row!.times_seen).toBe(N);
    expect(row!.times_resolved).toBe(0);
  });

  it("fail, fail, succeed for the same signature → times_seen = 3, times_resolved = 1", async () => {
    const store = statefulFakeStore();
    const node = makeLessonDispatch(store);

    // Two occurrences that never resolve, then a third whose retry succeeds.
    await node(stateWith({ results: [FAILED_RESULT] }));
    await node(stateWith({ results: [FAILED_RESULT] }));
    await node(stateWith({ results: [FAILED_RESULT] }));
    // Dispatch always stashes this exact shape from STEP + FAILED_RESULT
    // (see makeLessonDispatch Hook 2) — reconstructed directly rather than
    // read back off the update, which carries a LangGraph channel-update type
    // (possibly wrapped in OverwriteValue) rather than the plain value type.
    const candidate = {
      step_id: "s1",
      worker: "research",
      signature: LESSON.signature,
      component: "research",
      objective: STEP.objective,
    };

    const resolved = await node(stateWith({ results: [OK_RESULT], lesson_candidate: candidate }));

    expect(store.recordOccurrence).toHaveBeenCalledTimes(3);
    expect(store.record).toHaveBeenCalledTimes(1);
    const row = store.rows.get(`research:${LESSON.signature}`);
    expect(row).toBeDefined();
    expect(row!.times_seen).toBe(3);
    expect(row!.times_resolved).toBe(1);
    expect(resolved.lesson_candidate).toBeNull();
  });

  // ── Structural discrimination (no forged resolution) ────────────────────────

  it("a forged 'ok' result for a DIFFERENT step cannot be mistaken for the candidate's own resolution", async () => {
    const store = statefulFakeStore();
    const node = makeLessonDispatch(store);
    const candidate = {
      step_id: "s1",
      worker: "research",
      signature: LESSON.signature,
      component: "research",
      objective: STEP.objective,
    };
    // s1 — the step the candidate actually belongs to — is STILL failed.
    // Only an unrelated step (s9) produced an ok StepResult. If the check
    // were not step_id-scoped, this could be misread as "the candidate
    // resolved" and falsely bump times_resolved.
    const unrelatedOk: StepResult = { ...OK_RESULT, step_id: "s9" };

    const update = await node(stateWith({ results: [FAILED_RESULT, unrelatedOk], lesson_candidate: candidate }));

    expect(store.record).not.toHaveBeenCalled(); // s1 itself never validated ok — no resolution recorded
    const row = store.rows.get(`research:${LESSON.signature}`);
    expect(row?.times_resolved ?? 0).toBe(0);
    // s1 is still failing, so dispatch legitimately builds ANOTHER retry for
    // it — the new candidate must genuinely be s1's own next attempt, never
    // something derived from s9's unrelated ok result.
    expect(update.lesson_candidate).toMatchObject({ step_id: "s1", worker: "research" });
  });

  it("a free-text 'success' claim outside state.results (scratch/messages) cannot forge a resolution", async () => {
    const store = statefulFakeStore();
    const node = makeLessonDispatch(store);
    const candidate = {
      step_id: "s1",
      worker: "research",
      signature: LESSON.signature,
      component: "research",
      objective: STEP.objective,
    };
    // The model-authored channel (scratch) claims success in free text, but
    // the code-validated result for s1 (state.results) is still "failed".
    // Hook 1 must read state.results exclusively, never scratch content.
    const forgedScratch = { s1: [new HumanMessage("status: ok, resolved successfully!")] };

    const update = await node(
      stateWith({ results: [FAILED_RESULT], lesson_candidate: candidate, scratch: forgedScratch }),
    );

    expect(store.record).not.toHaveBeenCalled();
    const row = store.rows.get(`research:${LESSON.signature}`);
    expect(row?.times_resolved ?? 0).toBe(0);
  });

// ── AUDIT scope: what `times_seen` does and does NOT count ────────────────────
//
// The occurrence write lives on the RETRY-DISPATCH path, so `times_seen` counts
// failures that ENTERED THE RETRY SEAM — a lower bound on total failures, not a
// count of them. These tests pin that boundary so the module header's SCOPE note
// and the schema comment cannot silently drift from the code. If a future change
// makes occurrences unconditional, these are the tests to update — deliberately,
// together with the docs.
describe("occurrence scope (lower-bound semantics)", () => {
  const nonRetryable: StepResult = {
    status: "failed",
    step_id: "s1",
    failure: { ...(FAILED_RESULT as any).failure, retryable: false },
  };

  it("does NOT record an occurrence for a NON-RETRYABLE failure (dispatch builds no retry)", async () => {
    const store = fakeStore();
    const node = makeLessonDispatch(store);
    await node(stateWith({ results: [nonRetryable], attempts: { s1: 1 } }));
    expect(store.recordOccurrence).not.toHaveBeenCalled();
  });

  it("does NOT record an occurrence for the FINAL attempt of an exhausted step", async () => {
    const store = fakeStore();
    const node = makeLessonDispatch(store);
    await node(stateWith({ results: [FAILED_RESULT], attempts: { s1: MAX_ATTEMPTS_PER_STEP } }));
    expect(store.recordOccurrence).not.toHaveBeenCalled();
  });

  it("DOES record an occurrence for a retryable failure with attempts remaining", async () => {
    const store = fakeStore();
    const node = makeLessonDispatch(store);
    await node(stateWith({ results: [FAILED_RESULT], attempts: { s1: 1 } }));
    expect(store.recordOccurrence).toHaveBeenCalledTimes(1);
  });
});
});
