/**
 * replyForError — a 402 "credits used up" that survives the free fallback chain (issue #1064).
 *
 * shouldEngageFallback sends a 402 to the free models; when they fail too, the
 * gateway rethrows the 402. Before this fix it reached the founder as a raw
 * "❌ Error" with a Retry button, which cannot help until someone tops up.
 */

import { describe, it, expect, vi } from "vitest";
import type { Context } from "grammy";

const enqueueTurnAutoRetry = vi.fn(async () => true);
vi.mock("../../../src/gateway/auto-retry.js", () => ({ enqueueTurnAutoRetry }));

const { replyForError } = await import("../../../src/gateway/error-reply.js");

async function shown(err: unknown): Promise<{ text: string; opts: Record<string, unknown> }> {
  const replies: { text: string; opts: Record<string, unknown> }[] = [];
  const ctx = {
    reply: async (text: string, opts: Record<string, unknown> = {}) => void replies.push({ text, opts }),
  } as unknown as Context;
  await replyForError(ctx, err, { chatId: "1", text: "check my inbox", turnId: "t1" });
  return replies[0] ?? { text: "", opts: {} };
}

const credits402 = (): Error =>
  Object.assign(new Error("402 Insufficient credits. Add more using https://openrouter.ai/settings/credits"), { status: 402 });

describe("replyForError — credits used up (402)", () => {
  it("says the credits are used up and where to top up, not a raw ❌ Error", async () => {
    const { text } = await shown(credits402());
    expect(text).toContain("💳");
    expect(text).toMatch(/credits are used up/i);
    expect(text).toContain("https://openrouter.ai/settings/credits");
    expect(text).not.toContain("❌");
  });

  it("offers no Retry button and queues no auto-retry: a retry cannot work until a top-up", async () => {
    const { opts } = await shown(credits402());
    expect(opts["reply_markup"]).toBeUndefined();
    expect(enqueueTurnAutoRetry).not.toHaveBeenCalled();
  });

  it("a 429 rate limit still takes the auto-retry path", async () => {
    const { text } = await shown(Object.assign(new Error("429 quota exceeded per minute"), { status: 429 }));
    expect(text).toMatch(/rate-limited/);
    expect(enqueueTurnAutoRetry).toHaveBeenCalledTimes(1);
  });
});
