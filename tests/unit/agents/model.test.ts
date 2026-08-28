import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatVertexAI } from "@langchain/google-vertexai";
import { ChatOpenAI } from "@langchain/openai";
import {
  DEFAULT_AGENT_MODEL,
  RETRY_BACKOFF_MS,
  getConfiguredModelId,
  getFallbackModelIds,
  getModel,
  getModelFallbackMiddleware,
  getSupervisorModel,
  getWorkerModelId,
  is503Error,
  isQuotaExhaustedError,
  normalizeModelId,
  parseModelId,
} from "../../../src/agents/model.js";

describe("worker model split (roadmap #10)", () => {
  afterEach(() => {
    delete process.env["WORKER_AGENT_MODEL"];
    delete process.env["AGENT_MODEL"];
  });

  it("defaults the worker id to the primary model id when unset (no split)", () => {
    delete process.env["WORKER_AGENT_MODEL"];
    process.env["AGENT_MODEL"] = "openrouter:google/gemini-2.5-flash";
    expect(getWorkerModelId()).toBe(getConfiguredModelId());
  });

  it("honours a cheaper WORKER_AGENT_MODEL override (distinct from primary)", () => {
    process.env["AGENT_MODEL"] = "openrouter:google/gemini-2.5-flash";
    process.env["WORKER_AGENT_MODEL"] = "openrouter:google/gemini-2.5-flash-lite";
    expect(getWorkerModelId()).toBe(normalizeModelId("openrouter:google/gemini-2.5-flash-lite"));
    expect(getWorkerModelId()).not.toBe(getConfiguredModelId()); // a real split
  });

  it("blank/whitespace WORKER_AGENT_MODEL falls back to primary (never empty)", () => {
    process.env["WORKER_AGENT_MODEL"] = "   ";
    process.env["AGENT_MODEL"] = "openrouter:google/gemini-2.5-flash";
    expect(getWorkerModelId()).toBe(getConfiguredModelId());
  });
});

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
    // gemini-2.5-flash, not gemini-flash-latest: Vertex AI does not support AI
    // Studio's rolling "-latest" aliases (404, live-verified 2026-08-29).
    expect(parseModelId("google-vertexai:gemini-2.5-flash")).toEqual({
      provider: "google-vertexai",
      model: "gemini-2.5-flash",
      id: "google-vertexai:gemini-2.5-flash",
    });
    expect(parseModelId("openrouter:openai/gpt-4o-mini")).toEqual({
      provider: "openrouter",
      model: "openai/gpt-4o-mini",
      id: "openrouter:openai/gpt-4o-mini",
    });
  });

  // 2026-08-28: bare "gemini*" ids default to google-vertexai (the production-
  // reliable path — see vertex-migration audit). google-genai: still works when
  // explicitly prefixed, tested above.
  it("keeps legacy unprefixed names working by inference", () => {
    expect(parseModelId("gemini-2.5-flash").provider).toBe("google-vertexai");
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

  it("normalizes retired gemini-2.5-flash to gemini-flash-latest (2026-07-11 retirement: 404 'no longer available to new users')", () => {
    expect(normalizeModelId("google-genai:gemini-2.5-flash")).toBe(
      "google-genai:gemini-flash-latest",
    );
    expect(normalizeModelId("openrouter:google/gemini-2.5-flash")).toBe(
      "openrouter:google/gemini-flash-latest",
    );
  });

  // 2026-08-27: DEPRECATED_MODEL_ALIASES used to redirect dead OpenRouter
  // free-tier slugs to a literal "openrouter/free" — never a real model id
  // (verified against the live OpenRouter catalog). That laundered a
  // debuggable 404 (the real dead slug) into a still-broken 404 under a fake
  // name, which is strictly worse for diagnosis. Free-tier liveness rots too
  // fast for a static table to guess a replacement; the real defense is
  // scripts/probe-openrouter-free-models.ts run as a pre-deploy check. These
  // ids should now pass through unchanged so a 404 names the real culprit.
  it("no longer launders known-dead OpenRouter free-tier slugs into a fake 'openrouter/free' id", () => {
    const deadSlugs = [
      "meta-llama/llama-3.3-70b-instruct:free",
      "meta-llama/llama-3.3-70b-instruct",
      "qwen/qwen-2.5-72b-instruct:free",
      "qwen/qwen3-next-80b-a3b-instruct:free",
      "qwen/qwen3-next-80b-a3b-instruct",
      "nousresearch/hermes-3-llama-3.1-405b:free",
      "deepseek/deepseek-r1:free",
      "google/gemini-2.5-flash:free",
    ];
    for (const slug of deadSlugs) {
      expect(normalizeModelId(`openrouter:${slug}`)).toBe(`openrouter:${slug}`);
    }
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
    delete process.env["GOOGLE_APPLICATION_CREDENTIALS"];
    delete process.env["GOOGLE_CLOUD_PROJECT"];
    delete process.env["GOOGLE_CLOUD_LOCATION"];
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

  // 2026-08-28: the vertex-migration audit found the prior attempt at this
  // swap silently relied on ambient gcloud ADC discovery — worked on a laptop
  // with a personal gcloud session, broke on prod (no gcloud, no ADC file).
  // These two tests are the fail-loud contract that replaces it: construct
  // ChatVertexAI ONLY with explicit authOptions/project, and throw a named
  // error rather than fall through to ADC when either is missing.
  it("returns a Vertex AI model for google-vertexai ids when credentials are configured", () => {
    process.env["AGENT_MODEL"] = "google-vertexai:gemini-2.5-flash";
    process.env["GOOGLE_APPLICATION_CREDENTIALS"] = "/tmp/does-not-need-to-exist-for-construction.json";
    process.env["GOOGLE_CLOUD_PROJECT"] = "test-project";
    expect(getModel()).toBeInstanceOf(ChatVertexAI);
  });

  it("throws naming exactly what's missing for google-vertexai ids without GCP credentials", () => {
    process.env["AGENT_MODEL"] = "google-vertexai:gemini-2.5-flash";
    delete process.env["GOOGLE_APPLICATION_CREDENTIALS"];
    delete process.env["GOOGLE_CLOUD_PROJECT"];
    expect(() => getModel()).toThrow(/GOOGLE_APPLICATION_CREDENTIALS and GOOGLE_CLOUD_PROJECT required/);
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

  // 2026-08-27: getConfiguredModelId()/getWorkerModelId() normalize deprecated
  // ids; getFallbackModelIds() never did — AGENT_FALLBACK_MODELS was the one
  // place a retired slug (meta-llama/llama-3.3-70b-instruct:free,
  // qwen/qwen3-next-80b-a3b-instruct:free) actually lived in prod, and the
  // alias table gave it zero protection. Fixed so the same renames apply here.
  it("normalizes deprecated ids inside AGENT_FALLBACK_MODELS, not just AGENT_MODEL/WORKER_AGENT_MODEL", () => {
    process.env["AGENT_FALLBACK_MODELS"] =
      "google-genai:gemini-2.5-flash-preview-05-20,openrouter:openai/gpt-4o-mini";
    expect(getFallbackModelIds()).toEqual([
      "google-genai:gemini-2.5-flash",
      "openrouter:openai/gpt-4o-mini",
    ]);
  });

  it("skips fallback models whose API keys are absent (prod-safe boot)", () => {
    process.env["AGENT_FALLBACK_MODELS"] = "anthropic:claude-haiku-4-5,google-genai:gemini-2.0-flash";
    delete process.env["ANTHROPIC_API_KEY"];
    delete process.env["GOOGLE_GENERATIVE_AI_API_KEY"];
    expect(() => getSupervisorModel()).not.toThrow();
    expect(getModelFallbackMiddleware()).toEqual([]);
  });

  it("skips google-vertexai fallback models whose GCP credentials are absent (prod-safe boot)", () => {
    process.env["AGENT_FALLBACK_MODELS"] = "anthropic:claude-haiku-4-5,google-vertexai:gemini-2.5-flash-lite";
    delete process.env["ANTHROPIC_API_KEY"];
    delete process.env["GOOGLE_APPLICATION_CREDENTIALS"];
    delete process.env["GOOGLE_CLOUD_PROJECT"];
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

  // G7 regression: word-boundary match prevents false positives on port numbers / longer codes
  it("G7: does not false-positive on strings containing '500' mid-word", () => {
    expect(is503Error(new Error("port 5001 already in use"))).toBe(false);
    expect(is503Error(new Error("error code 50042"))).toBe(false);
    expect(is503Error(new Error("HTTP 500 Internal Server Error"))).toBe(true);
    expect(is503Error(new Error("status: 503"))).toBe(true);
    expect(is503Error(new Error("429 Too Many Requests"))).toBe(true);
  });
});
