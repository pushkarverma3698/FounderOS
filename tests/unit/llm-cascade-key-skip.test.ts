/**
 * TDD — callCascade skips providers with no API key configured.
 *
 * Without this guard, a cascade with only OPENROUTER_API_KEY set would:
 *   1. POST to Anthropic → 401 (key missing)
 *   2. POST to Google → 401 (key missing)
 *   3. POST to OpenRouter → 200 ✓
 *
 * With the guard, providers without keys are skipped immediately:
 *   1. Anthropic → SKIP (no key) — zero HTTP calls
 *   2. Google → SKIP (no key) — zero HTTP calls
 *   3. OpenRouter → 200 ✓
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────

// Config mock: only OPENROUTER_API_KEY is set — Anthropic + Google are absent
vi.mock("../../src/core/config.js", () => ({
  env: {
    ANTHROPIC_API_KEY: undefined,
    GOOGLE_GENERATIVE_AI_API_KEY: undefined,
    OPENROUTER_API_KEY: "sk-or-test-key-123",
    OPENAI_API_KEY: undefined,
    LM_STUDIO_URL: "http://localhost:1234",
    LM_STUDIO_MODEL: "test-model",
    BUDGET_DAILY_USD: 999,
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
  },
  CASCADE: {
    md: [
      { provider: "google",     modelId: "gemini-2.0-flash" },
      { provider: "anthropic",  modelId: "claude-haiku-4-5" },
      { provider: "openrouter", modelId: "meta-llama/llama-3.3-70b-instruct:free" },
    ],
    ceo: [
      { provider: "anthropic",  modelId: "claude-sonnet-4-5" },
      { provider: "openrouter", modelId: "meta-llama/llama-3.3-70b-instruct:free" },
    ],
    code: [
      { provider: "lmstudio",   modelId: "test-model" },
      { provider: "openrouter", modelId: "qwen/qwen3-coder:free" },
    ],
    nano:          [{ provider: "openrouter", modelId: "meta-llama/llama-3.3-70b-instruct:free" }],
    deep_research: [{ provider: "openrouter", modelId: "deepseek/deepseek-r1:free" }],
    critic:        [{ provider: "openrouter", modelId: "meta-llama/llama-3.3-70b-instruct:free" }],
    local:         [{ provider: "lmstudio",   modelId: "test-model" }],
    video:         [{ provider: "google",     modelId: "veo-2.0-generate-001" }],
  },
  CIRCUIT_BREAKER_OPTIONS: {
    timeout: 5_000,
    errorThresholdPercentage: 50,
    resetTimeout: 10_000,
    volumeThreshold: 3,
  },
  RATE_LIMITER_OPTIONS: { maxConcurrent: 5, minTime: 0 },
  TIER_MAX_TOKENS: {
    ceo: 512, deep_research: 4096, md: 2048, code: 4096,
    nano: 256, local: 1024, video: 256, critic: 1024,
  },
  MODEL_COST_PER_1M: {
    "meta-llama/llama-3.3-70b-instruct:free": { input: 0, output: 0 },
  },
}));

vi.mock("../../src/db/queries.js", () => ({
  logLlmCost: vi.fn().mockResolvedValue(undefined),
  getTodayCostUsd: vi.fn().mockResolvedValue(0),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeOpenRouterResponse(content: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    }),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("callCascade — key-skip guard", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("skips Anthropic and Google providers when their keys are absent — goes straight to OpenRouter", async () => {
    mockFetch.mockResolvedValueOnce(makeOpenRouterResponse("Great LinkedIn post about AI!"));

    const { HumanMessage } = await import("@langchain/core/messages");
    const { callCascade } = await import("../../src/infra/llm.js");

    const result = await callCascade(
      "md",
      [new HumanMessage("Write a LinkedIn post")],
      { agent: "content_writer", tenant_id: "turicks" },
    );

    // Should succeed via OpenRouter
    expect(result.text).toBe("Great LinkedIn post about AI!");
    expect(result.provider).toBe("openrouter");

    // fetch should be called EXACTLY once — only the OpenRouter call
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // The single call must go to OpenRouter, NOT Anthropic or Google
    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("openrouter.ai");
    expect(url).not.toContain("anthropic.com");
    expect(url).not.toContain("googleapis.com");
  });

  it("skips Anthropic-first cascade entries (CEO tier) when Anthropic key is absent", async () => {
    mockFetch.mockResolvedValueOnce(makeOpenRouterResponse("Routing to sales department"));

    const { HumanMessage } = await import("@langchain/core/messages");
    const { callCascade } = await import("../../src/infra/llm.js");

    const result = await callCascade(
      "ceo",
      [new HumanMessage("Route this task")],
      { agent: "supervisor", tenant_id: "turicks" },
    );

    expect(result.provider).toBe("openrouter");
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("openrouter.ai");
    expect(url).not.toContain("anthropic.com");
  });

  it("throws AggregateError when all providers with keys also fail", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: async () => ({ error: { message: "rate limited" } }),
      statusText: "Too Many Requests",
    });

    const { HumanMessage } = await import("@langchain/core/messages");
    const { callCascade } = await import("../../src/infra/llm.js");

    await expect(
      callCascade("md", [new HumanMessage("test")], { agent: "bdr" }),
    ).rejects.toThrow(/all cascade entries/i);
  });
});
