/**
 * AG-031 model A/B: turn an EvalReport into the numbers the recommendation needs
 * (pass %, p50/p90 latency, dollars per turn) without a single paid call.
 */

import { describe, it, expect } from "vitest";
import { aggregate } from "../../../src/eval/scoring.js";
import { priceFor } from "../../../src/eval/model-prices.js";
import { percentile, summarizeRun, renderAbHeader, renderAbRow, renderRunDetail } from "../../../src/eval/run-summary.js";
import type { LlmCallUsage, TaskResult } from "../../../src/eval/types.js";

const TODAY = "2026-10-07";
const SONNET = "anthropic:claude-sonnet-5-5";
const FLASH = "google-genai:gemini-3.6-flash";
const LING = "openrouter:inclusionai/ling-3.0-flash";

const call = (model: string, inputTokens: number, outputTokens: number, stage = "worker"): LlmCallUsage => ({
  stage,
  agent: "kernel",
  model,
  inputTokens,
  outputTokens,
});

function result(id: string, opts: { passed: boolean; latencyMs?: number; usage?: LlmCallUsage[]; infra?: boolean }): TaskResult {
  return {
    task: { id, input: id, expectedRoute: "research" },
    observation: {
      route: opts.passed ? "research" : null,
      tools: [],
      hadInterrupt: false,
      ...(opts.infra && { error: "503" }),
      ...(opts.usage && { usage: opts.usage }),
    },
    routeCorrect: opts.passed,
    toolsCorrect: true,
    hitlCorrect: true,
    mentionsCorrect: true,
    infraError: opts.infra ?? false,
    passed: opts.passed,
    ...(opts.latencyMs !== undefined && { latencyMs: opts.latencyMs }),
  };
}

describe("percentile (nearest rank)", () => {
  it("picks the ceil(p*n)-th smallest value", () => {
    const ten = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
    expect(percentile(ten, 0.5)).toBe(5);
    expect(percentile(ten, 0.9)).toBe(9);
    expect(percentile([1000, 2000, 3000, 4000], 0.5)).toBe(2000);
    expect(percentile([1000, 2000, 3000, 4000], 0.9)).toBe(4000);
  });

  it("handles one value and no values", () => {
    expect(percentile([7], 0.9)).toBe(7);
    expect(percentile([], 0.5)).toBeUndefined();
  });
});

describe("priceFor (eval-only price table)", () => {
  it("prices the four models under test and ignores the provider prefix", () => {
    expect(priceFor(SONNET, TODAY)).toEqual({ inputPerM: 2, outputPerM: 10 });
    expect(priceFor(FLASH, TODAY)).toEqual({ inputPerM: 0.75, outputPerM: 3.75 });
    expect(priceFor("google-genai:gemini-3.1-pro-preview", TODAY)).toEqual({ inputPerM: 2, outputPerM: 12 });
    expect(priceFor(LING, TODAY)).toEqual({ inputPerM: 0.021, outputPerM: 0.063 });
  });

  it("applies the Gemini flash price step on 2027-01-01", () => {
    expect(priceFor(FLASH, "2026-12-31")).toEqual({ inputPerM: 0.75, outputPerM: 3.75 });
    expect(priceFor(FLASH, "2027-01-01")).toEqual({ inputPerM: 1.5, outputPerM: 7.5 });
  });

  it("returns undefined for a model it has no verified price for", () => {
    expect(priceFor("google-genai:gemini-9-ultra", TODAY)).toBeUndefined();
  });
});

describe("summarizeRun", () => {
  const report = aggregate([
    result("a", { passed: true, latencyMs: 1000, usage: [call(SONNET, 1000, 100, "planner"), call(FLASH, 2000, 500)] }),
    result("b", { passed: false, latencyMs: 4000, usage: [call(SONNET, 1000, 100, "planner")] }),
    result("c", { passed: true, latencyMs: 2000 }),
    result("d", { passed: false, infra: true, latencyMs: 60_000 }),
  ]);

  it("reports pass rate over scored tasks and counts infra errors separately", () => {
    const s = summarizeRun(report, TODAY);
    expect(s.turns).toBe(4);
    expect(s.passed).toBe(2);
    expect(s.scored).toBe(3);
    expect(s.infraErrors).toBe(1);
    expect(s.passRate).toBeCloseTo(2 / 3);
  });

  it("takes latency percentiles over scored tasks only (a 60 s infra timeout is not a model latency)", () => {
    const s = summarizeRun(report, TODAY);
    expect(s.p50Ms).toBe(2000);
    expect(s.p90Ms).toBe(4000);
  });

  it("sums tokens and dollars from every LLM call, per turn", () => {
    const s = summarizeRun(report, TODAY);
    expect(s.llmCalls).toBe(3);
    expect(s.inputTokens).toBe(4000);
    expect(s.outputTokens).toBe(700);
    // sonnet: 2000 in + 200 out = 0.004 + 0.002; flash: 2000 in + 500 out = 0.0015 + 0.001875
    expect(s.usd).toBeCloseTo(0.009375, 6);
    expect(s.usdPerTurn).toBeCloseTo(0.009375 / 4, 6);
    expect(s.callsByModel).toEqual({ [SONNET]: 2, [FLASH]: 1 });
    expect(s.unpricedModels).toEqual([]);
  });

  it("leaves dollars undefined and names the model when a call has no verified price", () => {
    const r = aggregate([result("a", { passed: true, latencyMs: 10, usage: [call("google-genai:gemini-9-ultra", 10, 10)] })]);
    const s = summarizeRun(r, TODAY);
    expect(s.usd).toBeUndefined();
    expect(s.usdPerTurn).toBeUndefined();
    expect(s.unpricedModels).toEqual(["google-genai:gemini-9-ultra"]);
  });

  it("reports no usage when the invoker captured none", () => {
    const s = summarizeRun(aggregate([result("a", { passed: true, latencyMs: 10 })]), TODAY);
    expect(s.llmCalls).toBe(0);
    expect(s.usd).toBeUndefined();
  });
});

describe("renderAbRow", () => {
  const s = summarizeRun(
    aggregate([
      result("a", { passed: true, latencyMs: 1000, usage: [call(SONNET, 1000, 100, "planner")] }),
      result("b", { passed: false, latencyMs: 4000, usage: [call(SONNET, 1000, 100, "planner")] }),
    ]),
    TODAY,
  );

  it("renders one markdown row with the config's stage models and the measured numbers", () => {
    const row = renderAbRow("B", { planner: SONNET, worker: FLASH, synthesizer: FLASH }, s);
    expect(row).toBe(`| B | ${SONNET} | ${FLASH} | 50% (1/2) | 1.0s / 4.0s | $0.0030 | 0 |`);
  });

  it("prints n/a for dollars it could not price", () => {
    const row = renderAbRow("X", { planner: "a:b", worker: "c:d", synthesizer: "c:d" }, { ...s, usdPerTurn: undefined });
    expect(row).toContain("| n/a |");
  });

  it("has a header with the same number of columns as the row", () => {
    const header = renderAbHeader().split("\n");
    const row = renderAbRow("B", { planner: SONNET, worker: FLASH, synthesizer: FLASH }, s);
    expect(header).toHaveLength(2);
    expect(header[0]!.split("|").length).toBe(row.split("|").length);
  });
});

describe("renderRunDetail", () => {
  const summaryOf = (usage: LlmCallUsage[]) =>
    summarizeRun(aggregate([result("a", { passed: true, latencyMs: 1000, usage })]), TODAY);

  it("lists what really answered, the token totals and the total dollars", () => {
    const text = renderRunDetail(summaryOf([call(SONNET, 1000, 100, "planner"), call(LING, 2000, 200)]));
    expect(text).toContain("LLM calls: 2; tokens in/out: 3000 / 300; total $0.0031");
    expect(text).toContain(`Calls by answering model: ${SONNET} x1, ${LING} x1`);
    expect(text).not.toContain("No verified price");
  });

  it("names the models it has no verified price for and says dollars are n/a", () => {
    const text = renderRunDetail(summaryOf([call(SONNET, 10, 10), call("openai:gpt-9", 10, 10)]));
    expect(text).toContain("total n/a");
    expect(text).toContain("No verified price for: openai:gpt-9; $ / turn is n/a.");
  });

  it("says so when no call was recorded instead of printing a zero", () => {
    expect(renderRunDetail(summaryOf([]))).toBe("No LLM calls were recorded, so $ / turn is n/a.");
  });
});
