/**
 * AG-031: building "anthropic:claude-sonnet-5-5" the way buildModel() always did sent
 * temperature 0 and thinking {type: "disabled"}; Anthropic documents a 400 for both on
 * Sonnet 5.5 (and Sonnet 5, Opus 4.7+, Fable, Mythos). Config B and C of the model A/B
 * could never have run. Older Claude models keep exactly what they got before.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import type { ChatAnthropic } from "@langchain/anthropic";
import { anthropicModelOptions } from "../../../src/agents/anthropic-options.js";
import { getModel } from "../../../src/agents/model.js";

describe("anthropicModelOptions", () => {
  it.each(["claude-sonnet-5-5", "claude-sonnet-5", "claude-opus-5-5", "claude-opus-4-8", "claude-opus-4-7", "claude-fable-5-1"])(
    "%s: no sampling parameters, adaptive thinking",
    (model) => {
      expect(anthropicModelOptions(model, 0)).toEqual({ thinking: { type: "adaptive" } });
    },
  );

  it.each(["claude-sonnet-4-6", "claude-sonnet-4-5", "claude-haiku-4-5", "claude-opus-4-6"])(
    "%s: unchanged, temperature passes through",
    (model) => {
      expect(anthropicModelOptions(model, 0)).toEqual({ temperature: 0 });
    },
  );
});

describe("buildModel for an anthropic: id", () => {
  afterEach(() => vi.unstubAllEnvs());

  const invocationParams = (id: string): Record<string, unknown> => {
    vi.stubEnv("ANTHROPIC_API_KEY", "dummy-not-a-real-key");
    vi.stubEnv("AGENT_MODEL", id);
    const model = getModel() as ChatAnthropic;
    return model.invocationParams({}) as unknown as Record<string, unknown>;
  };

  it("sends neither temperature nor thinking:disabled to Sonnet 5.5", () => {
    const params = invocationParams("anthropic:claude-sonnet-5-5");
    expect(params).not.toHaveProperty("temperature");
    expect(params["thinking"]).toEqual({ type: "adaptive" });
  });

  it("still sends temperature 0 to Sonnet 4.6, as before", () => {
    const params = invocationParams("anthropic:claude-sonnet-4-6");
    expect(params["temperature"]).toBe(0);
  });
});
