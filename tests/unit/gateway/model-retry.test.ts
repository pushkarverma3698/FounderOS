/**
 * Ironclad — withModelRetry: exponential backoff + jitter for 429/529/5xx.
 * Deterministic: sleeper + rng injected, no real timers.
 */

import { describe, it, expect, vi } from "vitest";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { withModelRetry, jitteredDelay, MODEL_RETRY_BACKOFF_MS } from "../../../src/gateway/model-retry.js";
import type { KernelBindableModel } from "../../../src/kernel/index.js";

const statusError = (status: number, message = `HTTP ${status}`) =>
  Object.assign(new Error(message), { status });

function flaky(failures: unknown[], reply = "recovered"): KernelBindableModel & { calls: number } {
  const model = {
    calls: 0,
    async invoke(_messages: BaseMessage[]): Promise<AIMessage> {
      const err = failures[model.calls];
      model.calls += 1;
      if (err) throw err;
      return new AIMessage(reply);
    },
  };
  return model;
}

function harness() {
  const sleeps: number[] = [];
  const sleeper = vi.fn(async (ms: number) => {
    sleeps.push(ms);
  });
  return { sleeps, sleeper, rng: () => 0.5 };
}

describe("withModelRetry", () => {
  it("absorbs two 429s with jittered backoff, then succeeds", async () => {
    const { sleeps, sleeper, rng } = harness();
    const model = flaky([statusError(429), statusError(429)]);
    const wrapped = withModelRetry(model, { sleeper, rng });

    const res = await wrapped.invoke([]);
    expect(res.content).toBe("recovered");
    expect(model.calls).toBe(3);
    // Equal jitter with rng=0.5 → 3/4 of each ceiling.
    expect(sleeps).toEqual([750, 1500]);
  });

  it("retries HTTP 529 (provider overloaded) the same way", async () => {
    const { sleeper, rng } = harness();
    const model = flaky([statusError(529, "529 Overloaded")]);
    const res = await withModelRetry(model, { sleeper, rng }).invoke([]);
    expect(res.content).toBe("recovered");
    expect(model.calls).toBe(2);
  });

  it("fails LOUD on 401 — no retry, no sleep", async () => {
    const { sleeps, sleeper, rng } = harness();
    const model = flaky([statusError(401, "401 invalid api key")]);
    await expect(withModelRetry(model, { sleeper, rng }).invoke([])).rejects.toThrow("401");
    expect(model.calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("passes 404 through untouched — model retirement belongs to the fallback chain", async () => {
    const { sleeps, sleeper, rng } = harness();
    const model = flaky([statusError(404, "404 model not found")]);
    await expect(withModelRetry(model, { sleeper, rng }).invoke([])).rejects.toThrow("404");
    expect(sleeps).toEqual([]);
  });

  it("exhausts the backoff schedule then throws the LAST provider error", async () => {
    const { sleeps, sleeper, rng } = harness();
    const errs = [statusError(429), statusError(503), statusError(529), statusError(429, "429 final")];
    const model = flaky(errs);
    await expect(withModelRetry(model, { sleeper, rng }).invoke([])).rejects.toThrow("429 final");
    expect(model.calls).toBe(1 + MODEL_RETRY_BACKOFF_MS.length);
    expect(sleeps).toHaveLength(MODEL_RETRY_BACKOFF_MS.length);
  });

  it("bindTools preserves the retry layer on the BOUND model", async () => {
    const { sleeper, rng } = harness();
    const bound = flaky([statusError(429)], "bound-reply");
    const base: KernelBindableModel = {
      invoke: async () => new AIMessage("unbound"),
      bindTools: () => bound,
    };
    const wrapped = withModelRetry(base, { sleeper, rng });
    const res = await wrapped.bindTools!([]).invoke([]);
    expect(res.content).toBe("bound-reply");
    expect(bound.calls).toBe(2);
  });
});

describe("jitteredDelay", () => {
  it("stays within (ceiling/2, ceiling]", () => {
    expect(jitteredDelay(4_000, () => 0)).toBe(2_000);
    expect(jitteredDelay(4_000, () => 1)).toBe(4_000);
    expect(jitteredDelay(4_000, () => 0.25)).toBe(2_500);
  });
});
