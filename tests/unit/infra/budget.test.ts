/**
 * Unit tests for the budget guard.
 *
 * Why: per-run cost/token caps protect against runaway LLM spend. The budget
 * guard is purely deterministic — no LLM needed to test it.
 *
 * TDD: these tests are RED until src/infra/budget.ts is implemented.
 */

import { describe, it, expect } from "vitest";
import {
  estimateCost,
  normalizeModelId,
  BudgetTracker,
  BudgetExceededError,
  MODEL_COSTS,
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

// ── BudgetGuardCallback — REAL propagation through LangChain's CallbackManager ──
//
// Bug (live-reproduced on prod 2026-07-07): BudgetGuardCallback.handleLLMEnd threw
// BudgetExceededError, but LangChain's CallbackManager catches every handler
// exception internally and only rethrows when the handler opts in via
// `raiseError: true` (see @langchain/core/dist/callbacks/manager.cjs — the
// `if (handler.raiseError) throw err;` guard in BaseRunManager.handleLLMEnd).
// Without that flag the throw becomes a swallowed "Error in handler
// BudgetGuardCallback, handleLLMEnd: ..." console log and the run keeps going —
// which is exactly what happened during the github_read infinite-loop incident:
// the budget cap was hit repeatedly but never aborted the run.
//
// This test drives the REAL CallbackManager (not a mock of it) per rule #19 —
// the office code path attaches BudgetGuardCallback via `callbacks: [...]` on
// office.invoke(), which is serviced by this exact manager.
describe("BudgetGuardCallback — propagates through the real LangChain CallbackManager", () => {
  it("rejects the run instead of only logging when the budget is exceeded", async () => {
    const { CallbackManager } = await import("@langchain/core/callbacks/manager");
    const { BudgetGuardCallback } = await import("../../../src/infra/budget.js");

    const tracker = new BudgetTracker({ maxUsd: 0.000_001, maxTokens: 1_000_000 });
    const cb = new BudgetGuardCallback(tracker, "gemini-2.5-flash");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const manager = CallbackManager.configure([cb as any]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runManagers = await manager!.handleLLMStart({ lc_serializable: false } as any, ["prompt"]);
    const runManager = runManagers[0]!;

    const fakeOutput = {
      generations: [
        [
          {
            text: "",
            generationInfo: {
              usage_metadata: { promptTokenCount: 500_000, candidatesTokenCount: 500_000 },
            },
          },
        ],
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    await expect(runManager.handleLLMEnd(fakeOutput)).rejects.toThrow(BudgetExceededError);
  });
});
