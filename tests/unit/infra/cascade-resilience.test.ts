/**
 * TDD — callCascade resilience behaviours.
 *
 * Each test resets modules to get fresh circuit breakers (module-level Map).
 *
 * Tests:
 *   1. Provider 1 fails → falls through to provider 2
 *   2. Provider 1 + 2 fail → falls through to provider 3
 *   3. All providers fail → throws AggregateError with all reasons
 *   4. AggregateError includes individual errors[] for each failure
 *   5. CEO tier routes to Anthropic first (claude-sonnet-4-5)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HumanMessage } from "@langchain/core/messages";

// ── Config mock factory ───────────────────────────────────────────────────────

function mockConfig() {
  return {
    env: {
      ANTHROPIC_API_KEY: "sk-ant-test",
      GOOGLE_GENERATIVE_AI_API_KEY: "google-test-key",
      OPENROUTER_API_KEY: "sk-or-test",
      OPENAI_API_KEY: undefined,
      LM_STUDIO_URL: "http://localhost:1234",
      LM_STUDIO_MODEL: "test-model",
      BUDGET_DAILY_USD: 999,
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
    },
    CASCADE: {
      md: [
        { provider: "anthropic",  modelId: "claude-haiku-4-5" },
        { provider: "google",     modelId: "gemini-2.5-flash" },
        { provider: "openrouter", modelId: "meta-llama/llama-3.3-70b-instruct:free" },
      ],
      ceo: [
        { provider: "anthropic",  modelId: "claude-sonnet-4-5" },
        { provider: "google",     modelId: "gemini-2.5-pro" },
      ],
      deep_research: [{ provider: "google",     modelId: "gemini-2.5-pro" }],
      code:          [{ provider: "openrouter", modelId: "qwen/qwen3-coder:free" }],
      nano:          [{ provider: "google",     modelId: "gemini-2.5-flash-lite" }],
      critic:        [{ provider: "anthropic",  modelId: "claude-haiku-4-5" }],
      local:         [{ provider: "openrouter", modelId: "meta-llama/llama-3.3-70b-instruct:free" }],
      video:         [{ provider: "google",     modelId: "veo-2.0-generate-001" }],
    },
    CIRCUIT_BREAKER_OPTIONS: {
      timeout: 5_000,
      errorThresholdPercentage: 50,
      resetTimeout: 30_000,
      volumeThreshold: 10, // high threshold so circuit doesn't trip mid-test
    },
    RATE_LIMITER_OPTIONS: { maxConcurrent: 5, minTime: 0 },
    TIER_MAX_TOKENS: {
      ceo: 512, deep_research: 4096, md: 2048, code: 4096,
      nano: 256, local: 1024, video: 256, critic: 1024,
    },
    MODEL_COST_PER_1M: {
      "claude-haiku-4-5":  { input: 0.25, output: 1.25 },
      "gemini-2.5-flash":  { input: 0.075, output: 0.30 },
      "meta-llama/llama-3.3-70b-instruct:free": { input: 0, output: 0 },
      "claude-sonnet-4-5": { input: 3.00, output: 15.00 },
      "gemini-2.5-pro":    { input: 1.25, output: 10.00 },
    },
  };
}

// ── Response builders ─────────────────────────────────────────────────────────

const anthropicOk = (text: string) => ({
  ok: true, status: 200,
  json: async () => ({ content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 20 } }),
});
const googleOk = (text: string) => ({
  ok: true, status: 200,
  json: async () => ({
    candidates: [{ content: { parts: [{ text }] } }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 },
  }),
});
const openRouterOk = (text: string) => ({
  ok: true, status: 200,
  json: async () => ({ choices: [{ message: { content: text } }], usage: { prompt_tokens: 10, completion_tokens: 20 } }),
});
const providerError = (status: number, message: string) => ({
  ok: false, status, statusText: message,
  json: async () => ({ error: { message } }),
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("callCascade — provider fallback resilience", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.resetModules(); // fresh circuit breakers each test
    vi.resetAllMocks(); // reset mockResolvedValueOnce queues
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("falls through to provider 2 when provider 1 fails with HTTP 503", async () => {
    vi.doMock("../../../src/core/config.js", () => mockConfig());
    vi.doMock("../../../src/db/queries.js", () => ({
      logLlmCost: vi.fn().mockResolvedValue(undefined),
      getTodayCostUsd: vi.fn().mockResolvedValue(0),
    }));

    mockFetch.mockResolvedValueOnce(providerError(503, "Service Unavailable"));
    mockFetch.mockResolvedValueOnce(googleOk("Success from Google"));

    const { callCascade } = await import("../../../src/infra/llm.js");
    const result = await callCascade("md", [new HumanMessage("test")], { agent: "test" });

    expect(result.text).toBe("Success from Google");
    expect(result.provider).toBe("google");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("falls through to provider 3 when providers 1 and 2 both fail", async () => {
    vi.doMock("../../../src/core/config.js", () => mockConfig());
    vi.doMock("../../../src/db/queries.js", () => ({
      logLlmCost: vi.fn().mockResolvedValue(undefined),
      getTodayCostUsd: vi.fn().mockResolvedValue(0),
    }));

    mockFetch.mockResolvedValueOnce(providerError(503, "Service Unavailable"));
    mockFetch.mockResolvedValueOnce(providerError(429, "Rate Limited"));
    mockFetch.mockResolvedValueOnce(openRouterOk("Success from OpenRouter"));

    const { callCascade } = await import("../../../src/infra/llm.js");
    const result = await callCascade("md", [new HumanMessage("test")], { agent: "test" });

    expect(result.text).toBe("Success from OpenRouter");
    expect(result.provider).toBe("openrouter");
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("throws AggregateError when every provider fails", async () => {
    vi.doMock("../../../src/core/config.js", () => mockConfig());
    vi.doMock("../../../src/db/queries.js", () => ({
      logLlmCost: vi.fn().mockResolvedValue(undefined),
    }));

    mockFetch.mockResolvedValueOnce(providerError(503, "Anthropic down"));
    mockFetch.mockResolvedValueOnce(providerError(429, "Google rate limited"));
    mockFetch.mockResolvedValueOnce(providerError(500, "OpenRouter error"));

    const { callCascade } = await import("../../../src/infra/llm.js");

    await expect(
      callCascade("md", [new HumanMessage("test")], { agent: "test" }),
    ).rejects.toThrow(AggregateError);
  });

  it("AggregateError.errors contains one entry per failed provider", async () => {
    vi.doMock("../../../src/core/config.js", () => mockConfig());
    vi.doMock("../../../src/db/queries.js", () => ({
      logLlmCost: vi.fn().mockResolvedValue(undefined),
    }));

    mockFetch.mockResolvedValueOnce(providerError(503, "Anthropic down"));
    mockFetch.mockResolvedValueOnce(providerError(429, "Google rate limited"));
    mockFetch.mockResolvedValueOnce(providerError(500, "OpenRouter error"));

    const { callCascade } = await import("../../../src/infra/llm.js");

    try {
      await callCascade("md", [new HumanMessage("test")], { agent: "test" });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AggregateError);
      const aggErr = err as AggregateError;
      // md has 3 entries — all failed → 3 errors
      expect(aggErr.errors).toHaveLength(3);
    }
  });

  it("CEO tier routes to Anthropic (claude-sonnet-4-5) first", async () => {
    vi.doMock("../../../src/core/config.js", () => mockConfig());
    vi.doMock("../../../src/db/queries.js", () => ({
      logLlmCost: vi.fn().mockResolvedValue(undefined),
    }));

    mockFetch.mockResolvedValueOnce(anthropicOk("Strategic advice"));

    const { callCascade } = await import("../../../src/infra/llm.js");
    const result = await callCascade("ceo", [new HumanMessage("strategic question")], { agent: "supervisor" });

    expect(result.provider).toBe("anthropic");
    expect(result.model).toBe("claude-sonnet-4-5");
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("anthropic.com");
  });
});
