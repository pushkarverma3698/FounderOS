/**
 * Outreach model routing — reflector defaults to OpenRouter free tier.
 */

import { describe, it, expect } from "vitest";
import {
  DEFAULT_REFLECTOR_MODEL,
  describeReflectorModel,
  describeGeneratorModel,
} from "../../../src/outreach/models.js";

describe("outreach model routing", () => {
  it("defaults reflector to OpenRouter free Llama", () => {
    const prev = process.env["OUTREACH_REFLECTOR_MODEL"];
    delete process.env["OUTREACH_REFLECTOR_MODEL"];
    try {
      expect(describeReflectorModel().id).toBe(DEFAULT_REFLECTOR_MODEL);
      expect(DEFAULT_REFLECTOR_MODEL).toMatch(/^openrouter:/);
      expect(DEFAULT_REFLECTOR_MODEL).toContain(":free");
    } finally {
      if (prev !== undefined) process.env["OUTREACH_REFLECTOR_MODEL"] = prev;
    }
  });

  it("respects OUTREACH_REFLECTOR_MODEL override", () => {
    const prev = process.env["OUTREACH_REFLECTOR_MODEL"];
    process.env["OUTREACH_REFLECTOR_MODEL"] = "openrouter:qwen/qwen3-next-80b-a3b-instruct:free";
    try {
      expect(describeReflectorModel().id).toBe("openrouter:qwen/qwen3-next-80b-a3b-instruct:free");
    } finally {
      if (prev === undefined) delete process.env["OUTREACH_REFLECTOR_MODEL"];
      else process.env["OUTREACH_REFLECTOR_MODEL"] = prev;
    }
  });

  it("generator defaults to google-genai when AGENT_MODEL unset", () => {
    const prevAgent = process.env["AGENT_MODEL"];
    const prevGen = process.env["OUTREACH_GENERATOR_MODEL"];
    delete process.env["AGENT_MODEL"];
    delete process.env["OUTREACH_GENERATOR_MODEL"];
    try {
      expect(describeGeneratorModel().provider).toBe("google-genai");
    } finally {
      if (prevAgent === undefined) delete process.env["AGENT_MODEL"];
      else process.env["AGENT_MODEL"] = prevAgent;
      if (prevGen === undefined) delete process.env["OUTREACH_GENERATOR_MODEL"];
      else process.env["OUTREACH_GENERATOR_MODEL"] = prevGen;
    }
  });
});
