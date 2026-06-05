/**
 * Unit tests for the office model factory.
 *
 * Determinism rule: routing and tool-calling must be reproducible so the eval
 * harness scores the same behaviour run-to-run. That means temperature 0 by
 * default. RED until getModel() pins temperature to 0 (it currently uses 0.3).
 *
 * Cascade rule: when the primary model returns a 503, fall back to the next
 * model in the list automatically (gemini-2.5-flash → gemini-2.0-flash →
 * gemini-1.5-flash) so a capacity spike doesn't kill the whole OS.
 */

import { describe, it, expect, afterEach } from "vitest";
import { getModel, is503Error } from "../../../src/agents/model.js";

describe("getModel temperature (determinism)", () => {
  afterEach(() => {
    delete process.env["AGENT_TEMPERATURE"];
  });

  it("defaults to temperature 0 for deterministic routing/tool-calling", () => {
    delete process.env["AGENT_TEMPERATURE"];
    expect(getModel().temperature).toBe(0);
  });

  it("honours a numeric AGENT_TEMPERATURE override (e.g. creative content runs)", () => {
    process.env["AGENT_TEMPERATURE"] = "0.7";
    expect(getModel().temperature).toBe(0.7);
  });

  it("falls back to 0 when AGENT_TEMPERATURE is non-numeric", () => {
    process.env["AGENT_TEMPERATURE"] = "not-a-number";
    expect(getModel().temperature).toBe(0);
  });
});

describe("is503Error", () => {
  it("detects 503 Service Unavailable from Gemini error message", () => {
    const err = new Error(
      "[GoogleGenerativeAI Error]: Error fetching from https://generativelanguage.googleapis.com: " +
        "[503 Service Unavailable] This model is currently experiencing high demand.",
    );
    expect(is503Error(err)).toBe(true);
  });

  it("detects 503 from plain number in message", () => {
    expect(is503Error(new Error("Request failed with status 503"))).toBe(true);
  });

  it("detects high demand message without 503 code", () => {
    expect(is503Error(new Error("high demand. Please try again later"))).toBe(true);
  });

  it("returns false for non-503 errors", () => {
    expect(is503Error(new Error("404 Not Found"))).toBe(false);
    expect(is503Error(new Error("400 Bad Request: invalid argument"))).toBe(false);
    expect(is503Error(new Error("401 Unauthorized"))).toBe(false);
  });

  it("returns false for non-Error values", () => {
    expect(is503Error("some string")).toBe(false);
    expect(is503Error(null)).toBe(false);
    expect(is503Error(undefined)).toBe(false);
  });
});

describe("getModel cascade config", () => {
  afterEach(() => {
    delete process.env["AGENT_MODEL"];
  });

  it("primary model defaults to gemini-2.5-flash", () => {
    delete process.env["AGENT_MODEL"];
    const m = getModel();
    expect(m.model).toBe("gemini-2.5-flash");
  });

  it("respects AGENT_MODEL override for primary model", () => {
    process.env["AGENT_MODEL"] = "gemini-1.5-flash";
    const m = getModel();
    expect(m.model).toBe("gemini-1.5-flash");
  });

  it("model instance has fallback models configured", () => {
    delete process.env["AGENT_MODEL"];
    const m = getModel();
    // The model should expose its fallback list so tests can assert on it
    const fallbacks = (m as unknown as { _fallbackModels: string[] })._fallbackModels;
    expect(Array.isArray(fallbacks)).toBe(true);
    expect(fallbacks.length).toBeGreaterThan(0);
    // None of the fallbacks should be the primary model
    expect(fallbacks).not.toContain("gemini-2.5-flash");
  });
});
