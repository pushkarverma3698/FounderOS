/**
 * Reliability: a quota/credits/billing 429 is NOT a transient capacity blip — it
 * will not recover within a request. The model layer must classify it as
 * non-recoverable and fail FAST to OpenRouter (a different key), instead of:
 *   (a) letting the Google SDK burn ~85s of internal backoff per call, and
 *   (b) re-trying same-key Google fallbacks that share the depleted credits.
 *
 * The production symptom this prevents: every office.invoke() hangs for minutes
 * (5+ model calls × ~85s) when Gemini credits are depleted, wedging the bot.
 */

import { describe, it, expect, vi } from "vitest";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { FounderChatModel, GeminiAdapter, isQuotaExhaustedError, is503Error } from "../../../src/agents/model.js";

/** Minimal fake chat model that always throws the given error from _generate. */
function throwingModel(err: Error) {
  return { _generate: vi.fn(async (): Promise<ChatResult> => { throw err; }) } as never;
}

const QUOTA_ERR = new Error(
  "[GoogleGenerativeAI Error]: Error fetching from ...generateContent: [429 Too Many Requests] Your prepayment credits are depleted.",
);

describe("isQuotaExhaustedError — non-recoverable billing/credit classification", () => {
  it("matches credits-depleted, billing, and quota-exceeded messages", () => {
    expect(isQuotaExhaustedError(QUOTA_ERR)).toBe(true);
    expect(isQuotaExhaustedError(new Error("429 You exceeded your current quota, please check your billing"))).toBe(true);
    expect(isQuotaExhaustedError(new Error("insufficient credits / payment required"))).toBe(true);
  });

  it("does NOT match transient capacity errors (those should still retry)", () => {
    expect(isQuotaExhaustedError(new Error("503 high demand, Service Unavailable"))).toBe(false);
    expect(isQuotaExhaustedError(new Error("429 rate limit exceeded, please retry"))).toBe(false);
    expect(isQuotaExhaustedError(new Error("ECONNRESET socket hang up"))).toBe(false);
    // sanity: those transient ones are still caught by is503Error
    expect(is503Error(new Error("503 high demand"))).toBe(true);
  });
});

describe("FounderChatModel._generate — fast-fail on depleted credits", () => {
  it("skips same-key Google fallbacks and goes straight to OpenRouter, fast", async () => {
    const googleFallback = throwingModel(QUOTA_ERR); // same depleted key → must NOT be called
    const openRouter = {
      invoke: vi.fn(async () => new AIMessage("openrouter-rescue")),
    } as never;

    const model = new FounderChatModel({
      primaryModel: throwingModel(QUOTA_ERR),
      adapter: new GeminiAdapter(),
      fallbackModels: ["gemini-2.5-flash-lite"],
      fallbackInstances: [googleFallback],
      openRouterFallback: openRouter,
    });

    const t0 = Date.now();
    const res = await model._generate([new HumanMessage("hi")], {} as never);
    const elapsed = Date.now() - t0;

    expect(res.generations[0]!.text).toBe("openrouter-rescue");
    // The same-key Google fallback must be skipped (it shares the depleted credits).
    expect((googleFallback as unknown as { _generate: ReturnType<typeof vi.fn> })._generate).not.toHaveBeenCalled();
    expect((openRouter as unknown as { invoke: ReturnType<typeof vi.fn> }).invoke).toHaveBeenCalledOnce();
    // No multi-second backoff sleeps on the quota path (would be >14s with retries).
    expect(elapsed).toBeLessThan(2_000);
  });
});
