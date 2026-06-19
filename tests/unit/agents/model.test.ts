import { describe, it, expect, afterEach } from "vitest";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatOpenAI } from "@langchain/openai";
import {
  DEFAULT_AGENT_MODEL,
  RETRY_BACKOFF_MS,
  getConfiguredModelId,
  getFallbackModelIds,
  getModel,
  getModelFallbackMiddleware,
  getSupervisorModel,
  is503Error,
  isQuotaExhaustedError,
  normalizeModelId,
  parseModelId,
} from "../../../src/agents/model.js";

describe("model id parsing", () => {
  it("defaults to OpenRouter for the current credit-depletion recovery path", () => {
    delete process.env["AGENT_MODEL"];
    expect(getConfiguredModelId()).toBe(DEFAULT_AGENT_MODEL);
  });

  it("parses explicit provider prefixes", () => {
    expect(parseModelId("google-genai:gemini-2.5-flash")).toEqual({
      provider: "google-genai",
      model: "gemini-2.5-flash",
      id: "google-genai:gemini-2.5-flash",
    });
    expect(parseModelId("openrouter:openai/gpt-4o-mini")).toEqual({
      provider: "openrouter",
      model: "openai/gpt-4o-mini",
      id: "openrouter:openai/gpt-4o-mini",
    });
  });

  it("keeps legacy unprefixed names working by inference", () => {
    expect(parseModelId("gemini-2.5-flash").provider).toBe("google-genai");
    expect(parseModelId("claude-haiku-4-5").provider).toBe("anthropic");
    expect(parseModelId("gpt-4o-mini").provider).toBe("openai");
  });

  it("rejects unsupported prefixes loudly", () => {
    expect(() => parseModelId("unknown:model")).toThrow(/unsupported agent_model provider/i);
  });

  it("normalizes retired preview model ids to stable names", () => {
    expect(normalizeModelId("openrouter:google/gemini-2.5-flash-preview-05-20")).toBe(
      "openrouter:google/gemini-2.5-flash",
    );
    expect(normalizeModelId("google-genai:gemini-2.5-flash-preview-05-20")).toBe(
      "google-genai:gemini-2.5-flash",
    );
  });

  it("applies normalization in getConfiguredModelId", () => {
    process.env["AGENT_MODEL"] = "openrouter:google/gemini-2.5-flash-preview-05-20";
    expect(getConfiguredModelId()).toBe("openrouter:google/gemini-2.5-flash");
    delete process.env["AGENT_MODEL"];
  });
});

describe("getModel provider selection", () => {
  beforeEach(() => {
    // P5: key must be present for default openrouter model to initialize
    process.env["OPENROUTER_API_KEY"] = "sk-or-test-key-for-vitest";
  });

  afterEach(() => {
    delete process.env["AGENT_MODEL"];
    delete process.env["AGENT_TEMPERATURE"];
    delete process.env["OPENROUTER_API_KEY"];
  });

  it("returns an OpenRouter-backed ChatOpenAI model by default", () => {
    const model = getModel();
    expect(model).toBeInstanceOf(ChatOpenAI);
    expect((model as unknown as { temperature: number }).temperature).toBe(0);
  });

  it("returns a Google model for google-genai ids", () => {
    process.env["AGENT_MODEL"] = "google-genai:gemini-2.5-flash";
    expect(getModel()).toBeInstanceOf(ChatGoogleGenerativeAI);
  });

  it("returns an Anthropic model for anthropic ids", () => {
    process.env["AGENT_MODEL"] = "anthropic:claude-haiku-4-5";
    expect(getModel()).toBeInstanceOf(ChatAnthropic);
  });

  it("honours AGENT_TEMPERATURE for intentionally creative runs", () => {
    process.env["AGENT_TEMPERATURE"] = "0.7";
    expect((getModel() as unknown as { temperature: number }).temperature).toBe(0.7);
  });

  it("falls back to deterministic temperature when AGENT_TEMPERATURE is invalid", () => {
    process.env["AGENT_TEMPERATURE"] = "not-a-number";
    expect((getModel() as unknown as { temperature: number }).temperature).toBe(0);
  });
});

describe("fallback middleware config", () => {
  const savedFallbacks = process.env["AGENT_FALLBACK_MODELS"];

  beforeEach(() => {
    // Ensure the default OpenRouter model can initialize (P5: key required at startup)
    process.env["OPENROUTER_API_KEY"] ||= "sk-or-test-key-for-vitest";
  });

  afterEach(() => {
    if (savedFallbacks !== undefined) process.env["AGENT_FALLBACK_MODELS"] = savedFallbacks;
    else delete process.env["AGENT_FALLBACK_MODELS"];
  });

  it("returns no middleware when no fallbacks are configured", () => {
    delete process.env["AGENT_FALLBACK_MODELS"];
    expect(getFallbackModelIds()).toEqual([]);
    expect(getModelFallbackMiddleware()).toEqual([]);
  });

  it("parses comma-separated fallback model ids and creates one middleware", () => {
    process.env["AGENT_FALLBACK_MODELS"] = "openrouter:openai/gpt-4o-mini, anthropic:claude-haiku-4-5";
    expect(getFallbackModelIds()).toEqual([
      "openrouter:openai/gpt-4o-mini",
      "anthropic:claude-haiku-4-5",
    ]);
    expect(getModelFallbackMiddleware()).toHaveLength(1);
  });

  it("skips fallback models whose API keys are absent (prod-safe boot)", () => {
    process.env["AGENT_FALLBACK_MODELS"] = "anthropic:claude-haiku-4-5,google-genai:gemini-2.0-flash";
    delete process.env["ANTHROPIC_API_KEY"];
    delete process.env["GOOGLE_GENERATIVE_AI_API_KEY"];
    expect(() => getSupervisorModel()).not.toThrow();
    expect(getModelFallbackMiddleware()).toEqual([]);
  });

  it("supervisor model exposes bindTools (createSupervisor hard requirement)", () => {
    process.env["AGENT_FALLBACK_MODELS"] = "anthropic:claude-haiku-4-5";
    delete process.env["ANTHROPIC_API_KEY"];
    const model = getSupervisorModel() as unknown as { bindTools?: unknown };
    expect(typeof model.bindTools).toBe("function");
  });
});

describe("error classifiers kept for logs and retry policy tests", () => {
  it("detects transient provider/network errors", () => {
    expect(is503Error(new Error("503 Service Unavailable high demand"))).toBe(true);
    expect(is503Error(new Error("read ECONNRESET"))).toBe(true);
    expect(is503Error(new Error("401 Unauthorized"))).toBe(false);
  });

  it("distinguishes depleted credits from transient rate limits", () => {
    expect(isQuotaExhaustedError(new Error("Your prepayment credits are depleted"))).toBe(true);
    expect(isQuotaExhaustedError(new Error("429 rate limit exceeded, please retry"))).toBe(false);
  });

  it("keeps the old backoff tuple exported for Gemini REST tooling", () => {
    expect(RETRY_BACKOFF_MS).toEqual([2_000, 4_000, 8_000]);
  });
});
