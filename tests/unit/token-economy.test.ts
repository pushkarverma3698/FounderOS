/**
 * RED tests for token economy enforcement.
 * These tests validate the Pillar 0 rules from docs/architecture/STRATEGIC-VISION.md.
 */

import { describe, it, expect } from "vitest";
import { LLM_CACHE_TTL, CONTENT_TEMPLATE_CACHE_TTL } from "../../src/core/config.js";
import { shouldAddPromptCache, shouldUseLocalModel } from "../../src/infra/llm.js";

describe("LLM Cache TTL — Pillar 0 token economy", () => {
  it("CEO tier is never cached (decisions must be fresh)", () => {
    expect(LLM_CACHE_TTL["ceo"]).toBe(0);
  });

  it("md tier cache is 6 hours", () => {
    expect(LLM_CACHE_TTL["md"]).toBe(6 * 3600);
  });

  it("nano tier cache is 24 hours", () => {
    expect(LLM_CACHE_TTL["nano"]).toBe(86400);
  });

  it("critic tier is never cached (must evaluate fresh content)", () => {
    expect(LLM_CACHE_TTL["critic"]).toBe(0);
  });
});

describe("Content template cache TTL", () => {
  it("is defined as 7 days (604800 seconds)", () => {
    expect(CONTENT_TEMPLATE_CACHE_TTL).toBe(7 * 24 * 60 * 60);
  });
});

describe("shouldAddPromptCache — Anthropic prompt caching", () => {
  it("returns true for system prompts > 1024 tokens (approx 4096 chars)", () => {
    const longPrompt = "word ".repeat(900); // ~4500 chars > 4096
    expect(shouldAddPromptCache(longPrompt)).toBe(true);
  });

  it("returns false for short system prompts", () => {
    const shortPrompt = "You are a helpful agent. Answer concisely.";
    expect(shouldAddPromptCache(shortPrompt)).toBe(false);
  });

  it("threshold is 4096 characters (approx 1024 tokens at 4 chars/token)", () => {
    const atThreshold = "a".repeat(4096);
    const justBelow = "a".repeat(4095);
    expect(shouldAddPromptCache(atThreshold)).toBe(true);
    expect(shouldAddPromptCache(justBelow)).toBe(false);
  });
});

describe("shouldUseLocalModel — Ollama routing for cheap tasks", () => {
  it("routes JSON extraction to local model", () => {
    expect(shouldUseLocalModel("json_extraction")).toBe(true);
  });

  it("routes commit message generation to local model", () => {
    expect(shouldUseLocalModel("commit_message")).toBe(true);
  });

  it("routes template filling to local model", () => {
    expect(shouldUseLocalModel("template_fill")).toBe(true);
  });

  it("routes classification to local model", () => {
    expect(shouldUseLocalModel("classification")).toBe(true);
  });

  it("does NOT route architectural reasoning to local model", () => {
    expect(shouldUseLocalModel("architecture_review")).toBe(false);
  });

  it("does NOT route bug scanning to local model", () => {
    expect(shouldUseLocalModel("bug_scan")).toBe(false);
  });

  it("does NOT route sales copy generation to local model", () => {
    expect(shouldUseLocalModel("sales_copy")).toBe(false);
  });
});
