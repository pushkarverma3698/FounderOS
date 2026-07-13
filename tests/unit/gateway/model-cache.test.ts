/**
 * withLlmCache — tenant-isolated LLM response cache wrapper (gateway seam).
 *
 * Invariants under test:
 *  - Disabled (default) → identity: the inner model is returned untouched.
 *  - Enabled + miss → inner.invoke runs once, response content is written.
 *  - Enabled + hit → inner.invoke is NOT called; cached content is rehydrated
 *    into an AIMessage the kernel can read via `.content`.
 *  - Tool-calling is NEVER cached: bindTools returns a non-caching wrapper so a
 *    worker's side-effecting decisions are always recomputed.
 *  - Fail-open: a throwing cache port never breaks a real invoke.
 */

import { describe, it, expect, vi } from "vitest";
import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { withLlmCache, type LlmCachePort } from "../../../src/gateway/model-cache.js";
import type { KernelBindableModel } from "../../../src/kernel/index.js";

function fakePort(): LlmCachePort & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  return {
    store,
    async get(key) {
      return (store.get(key) as { content: unknown } | undefined) ?? null;
    },
    async set(key, value) {
      store.set(key, value);
    },
  };
}

function stubModel(reply = "cached-reply") {
  const invoke = vi.fn(async (_messages: BaseMessage[]) => new AIMessage(reply));
  const bindTools = vi.fn(function (this: unknown) {
    return { invoke } as unknown as KernelBindableModel;
  });
  const model = { invoke, bindTools } as unknown as KernelBindableModel;
  return { model, invoke, bindTools };
}

const OPTS = { tenantId: "turicks", modelId: "google-genai:gemini-flash-latest", temperature: 0, ttlSeconds: 3600 };
const MSG = [new HumanMessage("what is 2+2?")];

describe("withLlmCache", () => {
  it("returns the inner model untouched when disabled", () => {
    const { model } = stubModel();
    const wrapped = withLlmCache(model, { ...OPTS, enabled: false, port: fakePort() });
    expect(wrapped).toBe(model);
  });

  it("caches a miss then serves the hit without re-invoking the model", async () => {
    const { model, invoke } = stubModel("42");
    const port = fakePort();
    const wrapped = withLlmCache(model, { ...OPTS, enabled: true, port });

    const first = await wrapped.invoke(MSG);
    expect(first.content).toBe("42");
    expect(invoke).toHaveBeenCalledTimes(1);

    const second = await wrapped.invoke(MSG);
    expect(second.content).toBe("42");
    expect(invoke).toHaveBeenCalledTimes(1); // served from cache, no second call
  });

  it("isolates cache entries by tenant", async () => {
    const { model } = stubModel("shared-prompt");
    const port = fakePort();
    await withLlmCache(model, { ...OPTS, tenantId: "turicks", enabled: true, port }).invoke(MSG);
    const keys = [...port.store.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toContain("llm:turicks:");
  });

  it("never caches tool-calling calls (bindTools bypasses the cache)", async () => {
    const { model, invoke } = stubModel("tool-decision");
    const port = fakePort();
    const bound = withLlmCache(model, { ...OPTS, enabled: true, port }).bindTools!([]);

    await bound.invoke(MSG);
    await bound.invoke(MSG);
    expect(invoke).toHaveBeenCalledTimes(2); // recomputed each time
    expect(port.store.size).toBe(0);
  });

  it("fails open when the cache port throws", async () => {
    const { model } = stubModel("live");
    const throwingPort: LlmCachePort = {
      get: async () => { throw new Error("redis down"); },
      set: async () => { throw new Error("redis down"); },
    };
    const wrapped = withLlmCache(model, { ...OPTS, enabled: true, port: throwingPort });
    const reply = await wrapped.invoke(MSG);
    expect(reply.content).toBe("live");
  });
});
