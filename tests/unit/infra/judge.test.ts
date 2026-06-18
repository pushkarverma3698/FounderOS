/**
 * Claude-as-judge (Phase 3) — generator≠critic (CLAUDE rule #6).
 *
 * The drafting agents run on Gemini; the outbound judge runs on Claude, so the
 * critic can't rubber-stamp its own generation. The judge is gate 2 (after the
 * deterministic brand-validator) and is ALWAYS fail-open: any infra/parse
 * failure returns "pass" because HITL is the final, human gate — the judge must
 * never silently block the founder's workflow on its own confusion.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  parseJudgeVerdict,
  judgeOutbound,
  judgeRagAnswer,
  _resetJudgeCache,
  type JudgeModel,
} from "../../../src/infra/judge.js";

function modelReturning(content: unknown, calls?: { n: number }): JudgeModel {
  return {
    async invoke() {
      if (calls) calls.n += 1;
      return { content };
    },
  };
}

beforeEach(() => _resetJudgeCache());

describe("parseJudgeVerdict", () => {
  it("parses a clean pass verdict", () => {
    expect(parseJudgeVerdict('{"verdict":"pass"}')).toEqual({ verdict: "pass" });
  });

  it("parses a revise verdict with critique", () => {
    const v = parseJudgeVerdict('{"verdict":"revise","critique":"Too salesy; cut the hype."}');
    expect(v.verdict).toBe("revise");
    if (v.verdict === "revise") expect(v.critique).toMatch(/salesy/i);
  });

  it("tolerates fenced / surrounded JSON", () => {
    const v = parseJudgeVerdict('Sure!\n```json\n{"verdict":"pass"}\n```');
    expect(v.verdict).toBe("pass");
  });

  it("FAILS OPEN to pass on unparseable output (never block the founder)", () => {
    expect(parseJudgeVerdict("I cannot comply")).toEqual({ verdict: "pass" });
    expect(parseJudgeVerdict("")).toEqual({ verdict: "pass" });
  });

  it("FAILS OPEN to pass when verdict says revise but critique is missing", () => {
    // Without an actionable critique a 'revise' is useless — degrade to pass.
    expect(parseJudgeVerdict('{"verdict":"revise"}')).toEqual({ verdict: "pass" });
  });
});

describe("judgeOutbound", () => {
  it("returns the model's pass verdict", async () => {
    const v = await judgeOutbound("Clean, helpful copy.", "outreach", {
      model: modelReturning('{"verdict":"pass"}'),
    });
    expect(v.verdict).toBe("pass");
  });

  it("returns a revise verdict with the critique", async () => {
    const v = await judgeOutbound("BUY NOW!!! synergy disrupt", "linkedin", {
      model: modelReturning('{"verdict":"revise","critique":"Drop the hype words."}'),
    });
    expect(v.verdict).toBe("revise");
  });

  it("FAILS OPEN to pass when the model throws (infra error never blocks send)", async () => {
    const throwing: JudgeModel = {
      async invoke() {
        throw new Error("anthropic 529 overloaded");
      },
    };
    const v = await judgeOutbound("anything", "outreach", { model: throwing });
    expect(v.verdict).toBe("pass");
  });

  it("memoizes identical (text, channel) within TTL — resume re-run is a cache hit, not a 2nd Claude call", async () => {
    const calls = { n: 0 };
    const model = modelReturning('{"verdict":"pass"}', calls);
    const text = "The exact same draft body.";
    await judgeOutbound(text, "outreach", { model });
    await judgeOutbound(text, "outreach", { model }); // interrupt() re-execution
    expect(calls.n).toBe(1);
  });

  it("does NOT collide different channels for identical text", async () => {
    const calls = { n: 0 };
    const model = modelReturning('{"verdict":"pass"}', calls);
    await judgeOutbound("same body", "outreach", { model });
    await judgeOutbound("same body", "linkedin", { model });
    expect(calls.n).toBe(2);
  });
});

describe("judgeRagAnswer", () => {
  it("returns pass when chunks are relevant", async () => {
    const v = await judgeRagAnswer(
      "TypeScript experience",
      ["Senior TypeScript engineer with 5 years React. Score: 0.85"],
      { model: modelReturning('{"verdict":"pass"}') },
    );
    expect(v.verdict).toBe("pass");
  });

  it("returns revise when chunks are off-topic", async () => {
    const v = await judgeRagAnswer(
      "salary history",
      ["JavaScript fundamentals tutorial content."],
      {
        model: modelReturning(
          '{"verdict":"revise","critique":"Chunks contain tutorials, not salary data."}',
        ),
      },
    );
    expect(v.verdict).toBe("revise");
  });

  it("FAILS OPEN to pass when model throws", async () => {
    const throwing: JudgeModel = {
      async invoke() {
        throw new Error("timeout");
      },
    };
    const v = await judgeRagAnswer("anything", ["chunk"], { model: throwing });
    expect(v.verdict).toBe("pass");
  });

  it("FAILS OPEN to pass when no API key and no injected model", async () => {
    const savedKey = process.env["ANTHROPIC_API_KEY"];
    delete process.env["ANTHROPIC_API_KEY"];
    try {
      const v = await judgeRagAnswer("anything", ["chunk"]);
      expect(v.verdict).toBe("pass");
    } finally {
      if (savedKey !== undefined) process.env["ANTHROPIC_API_KEY"] = savedKey;
    }
  });

  it("memoizes identical (query, chunks) within TTL", async () => {
    const calls = { n: 0 };
    const model = modelReturning('{"verdict":"pass"}', calls);
    await judgeRagAnswer("same query", ["same chunk"], { model });
    await judgeRagAnswer("same query", ["same chunk"], { model });
    expect(calls.n).toBe(1);
  });
});
