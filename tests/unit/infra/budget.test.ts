/**
 * Unit tests for the budget guard.
 *
 * Why: per-run cost/token caps protect against runaway LLM spend. The budget
 * guard is purely deterministic — no LLM needed to test it.
 *
 * TDD: these tests are RED until src/infra/budget.ts is implemented.
 */

import { describe, it, expect } from "vitest";
import type { LLMResult } from "@langchain/core/outputs";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatOpenAI } from "@langchain/openai";
import {
  estimateCost,
  normalizeModelId,
  BudgetTracker,
  BudgetExceededError,
  BudgetGuardCallback,
  MODEL_COSTS,
  type AccruedCall,
} from "../../../src/infra/budget.js";

// ── estimateCost ──────────────────────────────────────────────────────────────

describe("estimateCost", () => {
  it("returns 0 for zero tokens", () => {
    expect(estimateCost(0, 0, "gemini-2.5-flash")).toBe(0);
  });

  it("calculates cost for gemini-2.5-flash with known pricing", () => {
    // $0.075/M input + $0.30/M output
    const cost = estimateCost(1_000_000, 0, "gemini-2.5-flash");
    expect(cost).toBeCloseTo(0.075, 5);
  });

  it("calculates output cost correctly", () => {
    const cost = estimateCost(0, 1_000_000, "gemini-2.5-flash");
    expect(cost).toBeCloseTo(0.30, 5);
  });

  it("sums input + output cost", () => {
    const input = estimateCost(1_000_000, 0, "gemini-2.5-flash");
    const output = estimateCost(0, 1_000_000, "gemini-2.5-flash");
    const combined = estimateCost(1_000_000, 1_000_000, "gemini-2.5-flash");
    expect(combined).toBeCloseTo(input + output, 8);
  });

  it("uses a safe positive fallback for unknown models", () => {
    const cost = estimateCost(1_000_000, 1_000_000, "unknown-model-xyz");
    expect(cost).toBeGreaterThan(0);
  });

  it("exports MODEL_COSTS with at least 4 known models", () => {
    expect(Object.keys(MODEL_COSTS).length).toBeGreaterThanOrEqual(4);
    expect(MODEL_COSTS["gemini-2.5-flash"]).toBeDefined();
  });
});

// ── normalizeModelId (G6) ─────────────────────────────────────────────────────

describe("estimateCost — prod models are priced, not defaulted (2026-10-08)", () => {
  it.each([
    ["openrouter:anthropic/claude-sonnet-5.5", 2.0, 10.0],
    ["google-genai:gemini-3.8-flash", 0.75, 3.75],
    ["openrouter:google/gemini-3.8-flash", 0.75, 3.75],
    ["openrouter:inclusionai/ling-3.0-flash", 0.021, 0.063],
    ["inclusionai/ling-3.0-flash", 0.021, 0.063],
  ])("%s costs $%s/M in and $%s/M out", (model, inPerM, outPerM) => {
    expect(estimateCost(1_000_000, 0, model)).toBeCloseTo(inPerM, 6);
    expect(estimateCost(0, 1_000_000, model)).toBeCloseTo(outPerM, 6);
  });
});

describe("normalizeModelId — strips provider prefix for MODEL_COSTS lookup", () => {
  it("strips openrouter:google/ prefix", () => {
    expect(normalizeModelId("openrouter:google/gemini-2.5-flash")).toBe("gemini-2.5-flash");
  });

  it("strips openrouter:openai/ prefix", () => {
    expect(normalizeModelId("openrouter:openai/gpt-4o-mini")).toBe("gpt-4o-mini");
  });

  it("strips google-genai: prefix", () => {
    expect(normalizeModelId("google-genai:gemini-2.5-flash")).toBe("gemini-2.5-flash");
  });

  it("strips :free suffix used by OpenRouter free-tier", () => {
    expect(normalizeModelId("openrouter:google/gemini-2.5-flash:free")).toBe("gemini-2.5-flash");
    expect(normalizeModelId("deepseek-r1:free")).toBe("deepseek-r1");
  });

  it("leaves plain model IDs unchanged", () => {
    expect(normalizeModelId("gemini-2.5-flash")).toBe("gemini-2.5-flash");
    expect(normalizeModelId("claude-haiku-4-5")).toBe("claude-haiku-4-5");
  });

  it("ensures estimateCost resolves correctly for OpenRouter-prefixed models", () => {
    const withPrefix = estimateCost(1_000_000, 0, "openrouter:google/gemini-2.5-flash");
    const withoutPrefix = estimateCost(1_000_000, 0, "gemini-2.5-flash");
    expect(withPrefix).toBe(withoutPrefix);
    expect(withPrefix).toBe(0.075); // 0.075 per M input tokens
  });
});

// ── BudgetTracker ─────────────────────────────────────────────────────────────

describe("BudgetTracker", () => {
  it("starts at zero with ok check", () => {
    const tracker = new BudgetTracker({ maxUsd: 1.0, maxTokens: 100_000 });
    expect(tracker.check().ok).toBe(true);
    expect(tracker.summary.totalUsd).toBe(0);
    expect(tracker.summary.totalTokens).toBe(0);
  });

  it("accrues total tokens across multiple calls", () => {
    const tracker = new BudgetTracker({ maxUsd: 10, maxTokens: 100_000 });
    tracker.accrue(1_000, 500, "gemini-2.5-flash");
    tracker.accrue(2_000, 1_000, "gemini-2.5-flash");
    expect(tracker.summary.totalTokens).toBe(4_500);
  });

  it("breaks out input vs output tokens (measure-what-we-control: input is the cacheable prefix cost)", () => {
    const tracker = new BudgetTracker({ maxUsd: 10, maxTokens: 100_000 });
    tracker.accrue(1_000, 500, "gemini-2.5-flash");
    tracker.accrue(2_000, 1_000, "gemini-2.5-flash");
    expect(tracker.summary.totalInputTokens).toBe(3_000);
    expect(tracker.summary.totalOutputTokens).toBe(1_500);
    expect(tracker.summary.totalTokens).toBe(
      tracker.summary.totalInputTokens + tracker.summary.totalOutputTokens,
    );
  });

  it("accrues total USD cost across multiple calls", () => {
    const tracker = new BudgetTracker({ maxUsd: 10, maxTokens: 100_000 });
    tracker.accrue(1_000, 500, "gemini-2.5-flash");
    tracker.accrue(1_000, 500, "gemini-2.5-flash");
    const expected = estimateCost(1_000, 500, "gemini-2.5-flash") * 2;
    expect(tracker.summary.totalUsd).toBeCloseTo(expected, 8);
  });

  it("returns ok:false when USD limit is exceeded", () => {
    const tracker = new BudgetTracker({ maxUsd: 0.000_01, maxTokens: 1_000_000 });
    tracker.accrue(1_000_000, 1_000_000, "gemini-2.5-flash"); // ~$0.375 >> $0.00001
    const result = tracker.check();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/budget|exceed/i);
      expect(result.reason).toContain("$");
    }
  });

  it("returns ok:false when token limit is exceeded", () => {
    const tracker = new BudgetTracker({ maxUsd: 100, maxTokens: 100 });
    tracker.accrue(60, 60, "gemini-2.5-flash"); // 120 > 100 tokens
    const result = tracker.check();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/token/i);
    }
  });

  it("check remains ok when comfortably within limits", () => {
    const tracker = new BudgetTracker({ maxUsd: 1.0, maxTokens: 100_000 });
    tracker.accrue(100, 50, "gemini-2.5-flash");
    expect(tracker.check().ok).toBe(true);
  });

  it("check triggers at exactly the USD limit (boundary)", () => {
    const tracker = new BudgetTracker({ maxUsd: 0.075, maxTokens: 1_000_000 });
    tracker.accrue(1_000_000, 0, "gemini-2.5-flash"); // exactly $0.075
    // At or above the limit should fail
    expect(tracker.check().ok).toBe(false);
  });

  it("check triggers at exactly the token limit (boundary)", () => {
    const tracker = new BudgetTracker({ maxUsd: 100, maxTokens: 1_000 });
    tracker.accrue(500, 500, "gemini-2.5-flash"); // exactly 1000 tokens
    expect(tracker.check().ok).toBe(false);
  });
});

// ── BudgetExceededError ───────────────────────────────────────────────────────

// ── BudgetGuardCallback cost persistence (bug: kernel path never wrote ai_call_costs,
// so the daily budget cap read $0 forever and the cost ledger stayed empty) ──────

describe("BudgetGuardCallback — onAccrue sink", () => {
  const geminiResult = (input: number, output: number): LLMResult => ({
    generations: [[{ text: "ok", generationInfo: { usage_metadata: { promptTokenCount: input, candidatesTokenCount: output } } }]],
    llmOutput: {},
  });

  it("reports every call to the sink with the computed usd", async () => {
    const calls: Array<{ model: string; inputTokens: number; outputTokens: number; usd: number }> = [];
    const cb = new BudgetGuardCallback(
      new BudgetTracker({ maxUsd: 1, maxTokens: 100_000 }),
      "google-genai:gemini-2.5-flash",
      (c) => calls.push(c),
    );
    await cb.handleLLMEnd(geminiResult(1000, 500));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      model: "google-genai:gemini-2.5-flash",
      inputTokens: 1000,
      outputTokens: 500,
      usd: estimateCost(1000, 500, "google-genai:gemini-2.5-flash"),
    });
  });

  it("still reports the call that blows the budget (the overage must be on the ledger)", async () => {
    const calls: unknown[] = [];
    const cb = new BudgetGuardCallback(
      new BudgetTracker({ maxUsd: 0.000001, maxTokens: 10 }),
      "gemini-2.5-flash",
      (c) => calls.push(c),
    );
    await expect(cb.handleLLMEnd(geminiResult(1000, 500))).rejects.toThrow(BudgetExceededError);
    expect(calls).toHaveLength(1);
  });
});

// ── Gemini thought tokens (2026-09-28 audit §1) ───────────────────────────────
//
// Gemini bills thought tokens as output, but @langchain/google-genai 2.1.31
// sets output = candidatesTokenCount and drops thoughtsTokenCount
// (convertUsageMetadata, dist/utils/common.js:468-472). Only totalTokenCount
// still carries them, as llmOutput.tokenUsage.totalTokens. These cases run the
// REAL libraries' own result mapping with the HTTP call replaced by a canned
// response, so the callback sees the library's LLMResult, not an imitation.

/** A real ChatGoogleGenerativeAI whose request returns a canned Gemini response. */
function geminiReturning(usageMetadata: Record<string, number>): ChatGoogleGenerativeAI {
  const model = new ChatGoogleGenerativeAI({ apiKey: "test-key", model: "gemini-3.8-flash", temperature: 0, maxRetries: 0 });
  (model as unknown as { completionWithRetry: () => Promise<unknown> }).completionWithRetry = async () => ({
    response: {
      candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP", index: 0 }],
      usageMetadata,
    },
  });
  return model;
}

/** A real OpenRouter-configured ChatOpenAI whose request returns a canned completion. */
function openRouterReturning(usage: Record<string, unknown>): ChatOpenAI {
  const model = new ChatOpenAI({
    model: "nvidia/nemotron-3-super-120b-a12b:free",
    apiKey: "sk-or-test",
    maxRetries: 0,
    configuration: { baseURL: "https://openrouter.ai/api/v1" },
  });
  (model as unknown as { completions: { completionWithRetry: () => Promise<unknown> } }).completions.completionWithRetry =
    async () => ({
      id: "gen-1",
      object: "chat.completion",
      created: 0,
      model: "nvidia/nemotron-3-super-120b-a12b:free",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop", logprobs: null }],
      usage,
    });
  return model;
}

function ledger(modelId: string): { calls: AccruedCall[]; tracker: BudgetTracker; cb: BudgetGuardCallback } {
  const calls: AccruedCall[] = [];
  const tracker = new BudgetTracker({ maxUsd: 10, maxTokens: 1_000_000 });
  return { calls, tracker, cb: new BudgetGuardCallback(tracker, modelId, (c) => calls.push(c)) };
}

describe("BudgetGuardCallback — thought tokens reach the ledger", () => {
  it("records Gemini's thought tokens as output (100 in, 50 visible, 250 thoughts → 300 out)", async () => {
    const { calls, tracker, cb } = ledger("google-genai:gemini-3.8-flash");
    await geminiReturning({ promptTokenCount: 100, candidatesTokenCount: 50, thoughtsTokenCount: 250, totalTokenCount: 400 })
      .invoke("hi", { callbacks: [cb] });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ inputTokens: 100, outputTokens: 300 });
    // Priced at the output rate: Gemini bills thoughts as output.
    expect(calls[0]!.usd).toBeCloseTo(estimateCost(100, 300, "google-genai:gemini-3.8-flash"), 12);
    // The run cap reads the same numbers as the ledger row.
    expect(tracker.summary.totalOutputTokens).toBe(300);
  });

  it("records the visible output unchanged when Gemini did not think", async () => {
    const { calls, cb } = ledger("google-genai:gemini-3.8-flash");
    await geminiReturning({ promptTokenCount: 100, candidatesTokenCount: 50, totalTokenCount: 150 })
      .invoke("hi", { callbacks: [cb] });
    expect(calls[0]).toMatchObject({ inputTokens: 100, outputTokens: 50 });
  });

  it("leaves an OpenRouter/OpenAI result unchanged — reasoning is already inside completion_tokens", async () => {
    const { calls, cb } = ledger("openrouter:nvidia/nemotron-3-super-120b-a12b:free");
    await openRouterReturning({
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      completion_tokens_details: { reasoning_tokens: 30 },
    }).invoke("hi", { callbacks: [cb] });
    expect(calls[0]).toMatchObject({ inputTokens: 100, outputTokens: 50 });
  });

  it("prefers a raw thoughtsTokenCount over total − input when a result carries one", async () => {
    // No installed integration hands the callback raw Gemini counts today, but
    // this branch already reads them (generationInfo.usage_metadata). The total
    // can include tokens that are not output (toolUsePromptTokenCount), so the
    // explicit thought count wins when it is there.
    const { calls, cb } = ledger("google-genai:gemini-3.8-flash");
    const raw: LLMResult = {
      generations: [[{
        text: "ok",
        generationInfo: {
          usage_metadata: { promptTokenCount: 100, candidatesTokenCount: 50, thoughtsTokenCount: 250, toolUsePromptTokenCount: 20, totalTokenCount: 420 },
        },
      }]],
      llmOutput: {},
    };
    await cb.handleLLMEnd(raw);
    expect(calls[0]).toMatchObject({ inputTokens: 100, outputTokens: 300 });
  });
});

describe("BudgetExceededError", () => {
  it("is an instance of Error", () => {
    const err = new BudgetExceededError("limit hit");
    expect(err).toBeInstanceOf(Error);
  });

  it("has name BudgetExceededError", () => {
    const err = new BudgetExceededError("limit hit");
    expect(err.name).toBe("BudgetExceededError");
  });

  it("exposes the reason string", () => {
    const err = new BudgetExceededError("Token budget exceeded: 50001 ≥ 50000");
    expect(err.reason).toBe("Token budget exceeded: 50001 ≥ 50000");
  });

  it("message includes the reason", () => {
    const err = new BudgetExceededError("my reason");
    expect(err.message).toContain("my reason");
  });
});
