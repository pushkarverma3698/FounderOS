/**
 * Answer-quality evaluation — the ASYNC half of the judge.
 * =========================================================
 * `judgeOutbound` is a guard: inline, before a send, and it fails OPEN to `pass`
 * because judge confusion must never block the founder. `judgeAnswer` is an
 * evaluator: it scores a reply the founder ALREADY received, so the opposite
 * failure direction applies — an unreadable or unreachable judge must produce
 * `not_evaluated` WITH a reason, never a score.
 *
 * The bug these tests exist to prevent is one line of stored data: a judge outage
 * that reads as "evaluated and passed". Every negative case below asserts that the
 * scores are absent and the reason is present.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  judgeAnswer,
  parseAnswerJudgement,
  _resetAnswerJudgeCache,
  ANSWER_SCORE_MAX,
  type JudgeModel,
  type AnswerJudgeInput,
} from "../../../src/infra/judge.js";
import {
  buildAnswerEvalRow,
  evaluateCompletedTurn,
  recordAnswerEvaluation,
  EVAL_DEFAULT_TENANT,
  type CompletedTurn,
} from "../../../src/infra/answer-eval.js";
import type { NewAnswerEvaluation } from "../../../src/db/schema.js";

function modelReturning(content: unknown): JudgeModel {
  return { async invoke() { return { content }; } };
}

const TURN: CompletedTurn = {
  turnId: "turn-1",
  threadId: "chat-42",
  goal: "Email the Q3 invoice to acme@example.com",
  reply: "Sent the Q3 invoice to acme@example.com.",
  steps: [
    { stepId: "s1", objective: "Send the invoice email", status: "ok", output: '{"message_id":"m-9"}' },
  ],
};

const INPUT: AnswerJudgeInput = { goal: TURN.goal, reply: TURN.reply, steps: TURN.steps };

beforeEach(() => _resetAnswerJudgeCache());

describe("parseAnswerJudgement", () => {
  it("parses three separately scored dimensions", () => {
    const j = parseAnswerJudgement('{"groundedness":90,"relevance":80,"completeness":70,"critique":"Fine."}');
    expect(j.status).toBe("evaluated");
    if (j.status === "evaluated") {
      expect(j.scores).toEqual({ groundedness: 90, relevance: 80, completeness: 70, critique: "Fine." });
    }
  });

  it("keeps a LOW groundedness score with a HIGH relevance score — the dimensions are never collapsed", () => {
    const j = parseAnswerJudgement('{"groundedness":0,"relevance":100,"completeness":100,"critique":"Claims an email that has no receipt."}');
    expect(j.status).toBe("evaluated");
    if (j.status === "evaluated") {
      expect(j.scores.groundedness).toBe(0);
      expect(j.scores.relevance).toBe(ANSWER_SCORE_MAX);
    }
  });

  it("tolerates fenced / surrounded JSON", () => {
    const j = parseAnswerJudgement('Sure:\n```json\n{"groundedness":50,"relevance":50,"completeness":50}\n```');
    expect(j.status).toBe("evaluated");
  });

  it("does NOT evaluate when the judge produced no JSON", () => {
    const j = parseAnswerJudgement("I cannot comply");
    expect(j.status).toBe("not_evaluated");
    if (j.status === "not_evaluated") expect(j.reason).toMatch(/no JSON object/i);
  });

  it("does NOT evaluate when a dimension is missing — and names the missing one", () => {
    const j = parseAnswerJudgement('{"groundedness":90,"relevance":80}');
    expect(j.status).toBe("not_evaluated");
    if (j.status === "not_evaluated") expect(j.reason).toContain("completeness");
  });

  it("does NOT evaluate on a NaN / non-numeric / out-of-range score (never a default)", () => {
    for (const raw of [
      '{"groundedness":"high","relevance":80,"completeness":70}',
      '{"groundedness":null,"relevance":80,"completeness":70}',
      '{"groundedness":900,"relevance":80,"completeness":70}',
      '{"groundedness":-5,"relevance":80,"completeness":70}',
    ]) {
      const j = parseAnswerJudgement(raw);
      expect(j.status).toBe("not_evaluated");
      if (j.status === "not_evaluated") expect(j.reason).toContain("groundedness");
    }
  });
});

describe("judgeAnswer", () => {
  const savedKey = process.env["OPENROUTER_API_KEY"];
  afterEach(() => {
    if (savedKey === undefined) delete process.env["OPENROUTER_API_KEY"];
    else process.env["OPENROUTER_API_KEY"] = savedKey;
  });

  it("scores a turn from an injected model (no network)", async () => {
    const j = await judgeAnswer(INPUT, {
      model: modelReturning('{"groundedness":95,"relevance":95,"completeness":95,"critique":""}'),
    });
    expect(j.status).toBe("evaluated");
  });

  it("returns NOT EVALUATED with the model name when no judge key is configured", async () => {
    delete process.env["OPENROUTER_API_KEY"];
    const j = await judgeAnswer(INPUT);
    expect(j.status).toBe("not_evaluated");
    if (j.status === "not_evaluated") {
      expect(j.reason).toMatch(/no API key configured/i);
      expect(j.reason).toMatch(/llama/i);
    }
  });

  it("returns NOT EVALUATED — never a score — when the judge call throws", async () => {
    const j = await judgeAnswer(INPUT, {
      model: { async invoke() { throw new Error("openrouter 503"); } },
    });
    expect(j.status).toBe("not_evaluated");
    if (j.status === "not_evaluated") expect(j.reason).toContain("openrouter 503");
  });

  it("does NOT cache a failure — the next attempt calls the judge again", async () => {
    let calls = 0;
    const flaky: JudgeModel = {
      async invoke() {
        calls += 1;
        if (calls === 1) throw new Error("transient");
        return { content: '{"groundedness":80,"relevance":80,"completeness":80}' };
      },
    };
    expect((await judgeAnswer(INPUT, { model: flaky })).status).toBe("not_evaluated");
    expect((await judgeAnswer(INPUT, { model: flaky })).status).toBe("evaluated");
    expect(calls).toBe(2);
  });
});

describe("buildAnswerEvalRow — 'not evaluated' can never be read as 'passed'", () => {
  it("stores the scores and no reason when the judge answered", () => {
    const row = buildAnswerEvalRow(
      TURN,
      { status: "evaluated", scores: { groundedness: 90, relevance: 85, completeness: 80, critique: "Solid." } },
      "openrouter:meta-llama/llama-3.3-70b-instruct:free",
    );
    expect(row.status).toBe("evaluated");
    expect(row.not_evaluated_reason).toBeNull();
    expect(row.groundedness).toBe(90);
    expect(row.tenant_id).toBe(EVAL_DEFAULT_TENANT);
    expect(row.planned_steps).toBe(1);
  });

  it("stores NULL scores and the reason when the judge did not answer", () => {
    const row = buildAnswerEvalRow(
      TURN,
      { status: "not_evaluated", reason: "judge model call failed — openrouter 503" },
      "openrouter:meta-llama/llama-3.3-70b-instruct:free",
    );
    expect(row.status).toBe("not_evaluated");
    expect(row.groundedness).toBeNull();
    expect(row.relevance).toBeNull();
    expect(row.completeness).toBeNull();
    expect(row.not_evaluated_reason).toContain("503");
  });
});

describe("evaluateCompletedTurn", () => {
  it("writes exactly one row for a scored turn", async () => {
    const rows: NewAnswerEvaluation[] = [];
    await evaluateCompletedTurn(TURN, {
      judge: async () => ({ status: "evaluated", scores: { groundedness: 60, relevance: 90, completeness: 90, critique: "x" } }),
      write: async (row) => { rows.push(row); },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("evaluated");
  });

  it("STILL writes a row when the judge failed — an unscored turn that leaves no row is invisible", async () => {
    const rows: NewAnswerEvaluation[] = [];
    await evaluateCompletedTurn(TURN, {
      judge: async () => ({ status: "not_evaluated", reason: "judge model call failed — timeout" }),
      write: async (row) => { rows.push(row); },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("not_evaluated");
    expect(rows[0]!.groundedness).toBeNull();
  });
});

describe("recordAnswerEvaluation — fire and forget", () => {
  it("returns before the judge resolves and never rejects when the write fails", async () => {
    let resolveJudge: (() => void) | undefined;
    const gate = new Promise<void>((r) => { resolveJudge = r; });
    let judged = false;

    const returned = recordAnswerEvaluation(TURN, {
      judge: async () => {
        await gate;
        judged = true;
        return { status: "evaluated", scores: { groundedness: 10, relevance: 10, completeness: 10, critique: "" } };
      },
      write: async () => { throw new Error("db down"); },
    });

    // Arrange–Act–Assert: the call has already returned while the judge is still pending.
    expect(returned).toBeUndefined();
    expect(judged).toBe(false);

    resolveJudge!();
    await new Promise((r) => setTimeout(r, 0));
    expect(judged).toBe(true); // the failed DB write was swallowed, not thrown
  });
});
