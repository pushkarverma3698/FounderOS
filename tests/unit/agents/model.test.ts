/**
 * Unit tests for the office model factory.
 *
 * Determinism rule: routing and tool-calling must be reproducible so the eval
 * harness scores the same behaviour run-to-run. That means temperature 0 by
 * default. RED until getModel() pins temperature to 0 (it currently uses 0.3).
 *
 * Cascade rule: when the primary model returns a 503, fall back to the next
 * model in the list. The fallback chain is currently empty (all sub-2.5 Gemini
 * models returned 404 as of June 2026). On 503 we surface the error directly.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { getModel, is503Error, RETRY_BACKOFF_MS } from "../../../src/agents/model.js";

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

  it("detects 500 Internal Server Error (transient Gemini capacity error)", () => {
    const err = new Error("[500 Internal Server Error] An internal error has occurred.");
    expect(is503Error(err)).toBe(true);
  });

  it("detects Internal Server Error without status code", () => {
    expect(is503Error(new Error("Internal Server Error encountered"))).toBe(true);
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

describe("RETRY_BACKOFF_MS constant", () => {
  it("exports a 3-element tuple [2000, 4000, 8000] for exponential backoff", () => {
    expect(RETRY_BACKOFF_MS).toEqual([2_000, 4_000, 8_000]);
  });
});

describe("retry with exponential backoff", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("retries on 503 and succeeds on the third attempt", async () => {
    let callCount = 0;
    vi.spyOn(ChatGoogleGenerativeAI.prototype as any, "_generate").mockImplementation(async () => {
      callCount++;
      if (callCount < 3) throw new Error("503 Service Unavailable high demand");
      return {
        generations: [[{ text: "ok", message: {} as any, generationInfo: {} }]],
        llmOutput: {},
      };
    });

    const model = getModel();
    const resultPromise = (model as any)._generate([], {});
    await vi.advanceTimersByTimeAsync(20_000);
    const result = await resultPromise;

    expect(callCount).toBe(3);
    expect(result.generations[0][0].text).toBe("ok");
  });

  it("throws after all retries + fallback exhausted (4 primary + 1 fallback = 5 total calls)", async () => {
    let callCount = 0;
    vi.spyOn(ChatGoogleGenerativeAI.prototype as any, "_generate").mockImplementation(async () => {
      callCount++;
      throw new Error("503 high demand");
    });

    const model = getModel();
    const resultPromise = (model as any)._generate([], {});
    // Suppress unhandled-rejection warning while timers advance —
    // the rejection is intentional and asserted below.
    resultPromise.catch(() => {});
    await vi.advanceTimersByTimeAsync(20_000);

    await expect(resultPromise).rejects.toThrow("503 high demand");
    // 1 initial + 3 retries (primary) + 1 fallback (gemini-2.5-flash-lite)
    expect(callCount).toBe(1 + RETRY_BACKOFF_MS.length + 1);
  });

  it("does not retry on non-transient errors (only 1 call on 400 Bad Request)", async () => {
    let callCount = 0;
    vi.spyOn(ChatGoogleGenerativeAI.prototype as any, "_generate").mockImplementation(async () => {
      callCount++;
      throw new Error("400 Bad Request: invalid argument");
    });

    const model = getModel();
    await expect((model as any)._generate([], {})).rejects.toThrow("400 Bad Request");
    expect(callCount).toBe(1);
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

  it("fallback chain includes gemini-2.5-flash-lite (confirmed available June 2026)", () => {
    delete process.env["AGENT_MODEL"];
    const m = getModel();
    const fallbacks = (m as unknown as { _fallbackModels: string[] })._fallbackModels;
    expect(fallbacks).toEqual(["gemini-2.5-flash-lite"]);
  });
});
