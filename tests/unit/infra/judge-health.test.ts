/**
 * A fail-open gate must be able to say it is failing.
 *
 * `judgeOutbound` is gate 2 for outbound copy and returns `pass` on ANY error —
 * correctly, since HITL is the real gate and a judge that blocks the founder on
 * its own confusion is worse than no judge. The price is that an OUTAGE and a
 * PASS are the same observable event, and that price came due three times:
 * meta-llama/llama-3.3-70b-instruct:free, nvidia/nemotron-3-super…:free (in
 * content-judge), and minimax/minimax-m2.7:free were each withdrawn from
 * OpenRouter's free tier without notice. The last one 404'd in production on
 * 2026-09-07 at 21:54:47, 21:56:14 and 21:57:15 — once per real outbound reply,
 * hours after being deployed as the fix for the previous dead slug — and
 * nothing surfaced it. It was found by grepping the raw journal.
 *
 * These pin the mechanism that ends that: consecutive failures are counted, one
 * alert is sent per outage episode, and the first success closes the episode.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  recordJudgeFailure,
  recordJudgeSuccess,
  judgeHealth,
  markJudgeOutageAlerted,
  _resetJudgeHealth,
  JUDGE_OUTAGE_THRESHOLD,
} from "../../../src/infra/judge-health.js";

beforeEach(() => _resetJudgeHealth());

describe("judgeHealth", () => {
  it("starts clean — a fresh process is not an outage", () => {
    expect(judgeHealth().consecutiveFailures).toBe(0);
    expect(judgeHealth().shouldAlert).toBe(false);
  });

  it("does not alert on a single transient failure", () => {
    recordJudgeFailure("500 upstream hiccup");
    expect(judgeHealth().shouldAlert).toBe(false);
  });

  it("alerts once the failures are consecutive past the threshold", () => {
    for (let i = 0; i < JUDGE_OUTAGE_THRESHOLD; i++) recordJudgeFailure("404 no such model");
    expect(judgeHealth().shouldAlert).toBe(true);
    expect(judgeHealth().lastError).toContain("404");
  });

  it("carries the last error, so the alert can name the cause", () => {
    recordJudgeFailure("first");
    recordJudgeFailure("second");
    recordJudgeFailure('404 This model is unavailable for free');
    expect(judgeHealth().lastError).toContain("unavailable for free");
  });

  it("sends ONE alert per episode, not one per failing call", () => {
    for (let i = 0; i < JUDGE_OUTAGE_THRESHOLD; i++) recordJudgeFailure("404");
    expect(judgeHealth().shouldAlert).toBe(true);
    markJudgeOutageAlerted();
    recordJudgeFailure("404");
    recordJudgeFailure("404");
    expect(judgeHealth().shouldAlert).toBe(false);
  });

  it("a single success closes the episode, so the NEXT outage alerts again", () => {
    for (let i = 0; i < JUDGE_OUTAGE_THRESHOLD; i++) recordJudgeFailure("404");
    markJudgeOutageAlerted();

    recordJudgeSuccess();
    expect(judgeHealth().consecutiveFailures).toBe(0);
    expect(judgeHealth().shouldAlert).toBe(false);

    for (let i = 0; i < JUDGE_OUTAGE_THRESHOLD; i++) recordJudgeFailure("404 again");
    expect(judgeHealth().shouldAlert).toBe(true);
  });

  it("an intermittent failure never accumulates into a false outage", () => {
    for (let i = 0; i < 10; i++) {
      recordJudgeFailure("blip");
      recordJudgeSuccess();
    }
    expect(judgeHealth().shouldAlert).toBe(false);
  });

  it("records when the last failure happened", () => {
    recordJudgeFailure("404", 1_700_000_000_000);
    expect(judgeHealth().lastFailureAt).toBe(1_700_000_000_000);
  });
});

describe("judgeOutbound wiring", () => {
  it("a model that throws is recorded as a failure, and still fails open to pass", async () => {
    const { judgeOutbound, _resetJudgeCache } = await import("../../../src/infra/judge.js");
    _resetJudgeCache();
    const dead = { invoke: vi.fn(async () => { throw new Error("404 no endpoints found"); }) };

    const verdict = await judgeOutbound("some draft copy", "outreach", { model: dead });

    // Fail-open is preserved — the founder is never blocked by a broken judge.
    expect(verdict).toEqual({ verdict: "pass" });
    // …but it is no longer silent.
    expect(judgeHealth().consecutiveFailures).toBe(1);
    expect(judgeHealth().lastError).toContain("404");
  });

  it("a working model clears the counter", async () => {
    const { judgeOutbound, _resetJudgeCache } = await import("../../../src/infra/judge.js");
    _resetJudgeCache();
    recordJudgeFailure("stale");
    const live = { invoke: vi.fn(async () => ({ content: '{"verdict":"pass"}' })) };

    await judgeOutbound("different draft copy", "outreach", { model: live });

    expect(judgeHealth().consecutiveFailures).toBe(0);
  });
});

describe("judgeAnswer wiring", () => {
  // judgeAnswer is the SECOND caller of this same fail-open judge (it scores replies
  // the founder already received, judgeOutbound gates outbound drafts before send) and
  // shares one model resolution path. Every real judge outage in production
  // (2026-09-07 through 2026-09-10, 17 occurrences) came through THIS function, not
  // judgeOutbound — so wiring only judgeOutbound to judge-health leaves the monitor
  // blind to the failure mode that motivated building it. See judge-health.ts.
  const baseInput = { goal: "test goal", reply: "test reply", steps: [] };

  it("a model that throws is recorded as a failure, and still fails open to not_evaluated", async () => {
    const { judgeAnswer, _resetAnswerJudgeCache } = await import("../../../src/infra/judge.js");
    _resetAnswerJudgeCache();
    const dead = { invoke: vi.fn(async () => { throw new Error("404 no endpoints found"); }) };

    const judgement = await judgeAnswer(baseInput, { model: dead });

    expect(judgement.status).toBe("not_evaluated");
    // …but it is no longer silent.
    expect(judgeHealth().consecutiveFailures).toBe(1);
    expect(judgeHealth().lastError).toContain("404");
  });

  it("a working model clears the counter", async () => {
    const { judgeAnswer, _resetAnswerJudgeCache } = await import("../../../src/infra/judge.js");
    _resetAnswerJudgeCache();
    recordJudgeFailure("stale");
    const live = {
      invoke: vi.fn(async () => ({
        content: '{"groundedness":5,"relevance":5,"completeness":5,"critique":""}',
      })),
    };

    await judgeAnswer({ ...baseInput, reply: "a different reply to dodge the cache" }, { model: live });

    expect(judgeHealth().consecutiveFailures).toBe(0);
  });

  // Root cause of the prod "Cannot read properties of undefined (reading 'message')"
  // incidents (2026-09-08T07:29, 2026-09-10T12:50): the catch block did
  // `(err as Error).message`, an unsafe cast. LangChain's OpenAI-compatible client can
  // reject with a value that isn't an Error instance (e.g. `undefined`, or a plain
  // object from a malformed provider response) — reading `.message` off that crashes
  // the error HANDLER itself, silently replacing the real judge-outage reason with a
  // TypeError. This was misdiagnosed as "the free slug died again" until traced here.
  it("a non-Error rejection is still turned into a real message, not a crash", async () => {
    const { judgeAnswer, _resetAnswerJudgeCache } = await import("../../../src/infra/judge.js");
    _resetAnswerJudgeCache();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately non-Error
    const throwsUndefined = { invoke: vi.fn(async () => { throw undefined as any; }) };

    const judgement = await judgeAnswer(
      { ...baseInput, reply: "reply for the non-Error rejection case" },
      { model: throwsUndefined },
    );

    expect(judgement.status).toBe("not_evaluated");
    expect(judgeHealth().consecutiveFailures).toBe(1);
    // The real assertion: judge-health recorded SOMETHING sane, not "Cannot read
    // properties of undefined (reading 'message')" from the handler crashing.
    expect(judgeHealth().lastError).not.toContain("Cannot read properties");
  });
});
