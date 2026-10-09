/**
 * OpenRouter key-limit 403 — a typed, terminal failure the founder can act on (issue #1052).
 *
 * Prod 2026-10-09: the key hit its $10 total limit and every turn replied with
 * OpenRouter's raw 403 text plus a key-hash URL. The fallback chain shares the
 * key, so it must not engage; the worker/synthesizer must not degrade it into a
 * retryable step failure; the reply must say which key, how much, and where to raise it.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { Context } from "grammy";
import type { KernelBindableModel } from "../../../src/kernel/index.js";
import { shouldEngageFallback } from "../../../src/agents/model.js";
import { isKeyLimitError, ProviderKeyLimitError } from "../../../src/agents/provider-key-limit.js";
import { withModelRetry } from "../../../src/gateway/model-retry.js";
import { withModelFallbacks } from "../../../src/gateway/model-fallback.js";
import { isKernelTerminalError } from "../../../src/kernel/errors.js";
import { replyForError } from "../../../src/gateway/error-reply.js";

/** The error @langchain/openai surfaces for OpenRouter's key-limit response (PermissionDeniedError, status 403). */
const keyLimit403 = () =>
  Object.assign(
    new Error("403 Key limit exceeded (total limit). Manage it using https://openrouter.ai/workspaces/default/keys/c2a5792d33"),
    { status: 403 },
  );

function model(err?: unknown): KernelBindableModel & { calls: number } {
  const m = {
    calls: 0,
    async invoke(_messages: BaseMessage[]): Promise<AIMessage> {
      m.calls += 1;
      if (err) throw err;
      return new AIMessage("answered");
    },
  };
  return m;
}

async function shown(err: unknown, retry = true): Promise<{ text: string; opts: Record<string, unknown> }> {
  const replies: { text: string; opts: Record<string, unknown> }[] = [];
  const ctx = {
    reply: async (text: string, opts: Record<string, unknown> = {}) => void replies.push({ text, opts }),
  } as unknown as Context;
  await replyForError(ctx, err, retry ? { chatId: "1", text: "hi", turnId: "t1" } : undefined);
  return replies[0]!;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("OpenRouter key-limit 403", () => {
  it("is recognised, and never engages the fallback chain", () => {
    expect(isKeyLimitError(keyLimit403())).toBe(true);
    expect(shouldEngageFallback(keyLimit403())).toBe(false);
    // An ordinary 403 is a different failure (bad key, region block) and keeps its own wording.
    expect(isKeyLimitError(Object.assign(new Error("403 Forbidden"), { status: 403 }))).toBe(false);
  });

  it("the retry layer turns it into ProviderKeyLimitError after one call", async () => {
    const primary = model(keyLimit403());
    await expect(withModelRetry(primary).invoke([])).rejects.toBeInstanceOf(ProviderKeyLimitError);
    expect(primary.calls).toBe(1);
  });

  it("the kernel stack fails fast without calling a fallback on the same key", async () => {
    const primary = model(keyLimit403());
    const fallback = model();
    const stack = withModelFallbacks(withModelRetry(primary), [fallback], "planner", { primaryRetryDelayMs: 0 });
    await expect(stack.invoke([])).rejects.toMatchObject({ name: "ProviderKeyLimitError" });
    expect(fallback.calls).toBe(0);
  });

  it("is kernel-terminal, so a worker cannot degrade it into a retryable step failure", () => {
    expect(isKernelTerminalError(new ProviderKeyLimitError(keyLimit403()))).toBe(true);
  });

  it("tells the founder the spend, the limit and where to raise it, with no Retry button", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    const fetchMock = vi.fn(async (_url: string | URL | Request) =>
      new Response(JSON.stringify({ data: { limit: 10, limit_remaining: 0, usage: 10.0065 } }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { text, opts } = await shown(new ProviderKeyLimitError(keyLimit403()));
    expect(text).toContain("OpenRouter key limit reached ($10.00 of $10.00)");
    expect(text).toContain("openrouter.ai/settings/keys");
    expect(text).not.toContain("c2a5792d33"); // the key-hash URL stays in the logs
    expect(opts["reply_markup"]).toBeUndefined(); // retrying cannot fix a spend limit
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://openrouter.ai/api/v1/key");
  });

  it("still says what happened when the usage lookup fails", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("fetch failed"); }));
    const { text } = await shown(keyLimit403(), false);
    expect(text).toContain("OpenRouter key limit reached");
    expect(text).toContain("openrouter.ai/settings/keys");
  });
});
