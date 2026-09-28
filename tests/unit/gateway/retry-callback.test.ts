/**
 * Tapping 🔁 Retry.
 *
 * The button carries only the first 8 characters of the failed turn's id (and
 * the candidate's profile, when the turn had one). The text to re-run comes
 * from the thread's checkpoint — `state.turn` is the LAST turn the kernel ran —
 * so a tap only acts while that failed turn is still the latest one.
 *
 * Defect hunt (plan §5), each pinned here:
 * - double tap: grammY handles updates one at a time and this handler awaits
 *   the retried turn, so the second tap sees the NEW turn id and stops;
 * - profile loss: a /wife_draft turn must retry as her, not as the default;
 * - stale card after a restart: the turn is read from the checkpointer, never
 *   from memory, and a failed read is answered, never thrown.
 */

import { describe, it, expect, vi } from "vitest";
import type { Context } from "grammy";
import { handleRetryCallback, STALE_RETRY_TEXT, type RetryCallbackDeps } from "../../../src/gateway/retry-callback.js";

const FAILED = { id: "3f2a9c1e-7b4d-4c2a-9e1f-0a1b2c3d4e5f", raw_input: "draft row 3 for tashi" };

function tapCtx(data: string) {
  const answers: Array<string | undefined> = [];
  const markupCleared: number[] = [];
  const ctx = {
    chat: { id: 777 },
    callbackQuery: { data },
    answerCallbackQuery: vi.fn(async (o?: { text?: string }) => void answers.push(o?.text)),
    editMessageReplyMarkup: vi.fn(async () => void markupCleared.push(1)),
  } as unknown as Context;
  return { ctx, answers, markupCleared };
}

/** A thread whose checkpoint advances when a turn runs — as the real kernel's does. */
function thread(initial: { id: string; raw_input: string } | null) {
  let current = initial;
  let n = 0;
  const runKernelText = vi.fn(async (_ctx: Context, text: string, _profileId?: string) => {
    current = { id: `9b8a7c6d-${++n}`, raw_input: text };
  });
  const deps: RetryCallbackDeps = {
    loadTurn: vi.fn(async () => current),
    runKernelText,
    isKnownProfile: (id) => id === "wife-nl-finance" || id === "pushkar-nl-tech",
  };
  return { deps, runKernelText };
}

describe("handleRetryCallback", () => {
  it("ignores payloads that are not a retry, so the other handlers still see them", async () => {
    const { deps, runKernelText } = thread(FAILED);
    const { ctx } = tapCtx("approve:abcd1234");
    expect(await handleRetryCallback(ctx, deps)).toBe(false);
    expect(runKernelText).not.toHaveBeenCalled();
  });

  it("re-runs the failed turn's own words and removes the button", async () => {
    const { deps, runKernelText } = thread(FAILED);
    const { ctx, markupCleared } = tapCtx("retry:3f2a9c1e");
    expect(await handleRetryCallback(ctx, deps)).toBe(true);
    expect(runKernelText).toHaveBeenCalledTimes(1);
    expect(runKernelText.mock.calls[0]![1]).toBe("draft row 3 for tashi");
    expect(runKernelText.mock.calls[0]![2]).toBeUndefined();
    expect(markupCleared).toHaveLength(1);
  });

  it("retries a Tashi-profile turn as Tashi (profile loss)", async () => {
    const { deps, runKernelText } = thread(FAILED);
    await handleRetryCallback(tapCtx("retry:3f2a9c1e:wife-nl-finance").ctx, deps);
    expect(runKernelText.mock.calls[0]![2]).toBe("wife-nl-finance");
  });

  it("runs once on a double tap: the first retry is a new turn, so the second tap is stale", async () => {
    const { deps, runKernelText } = thread(FAILED);
    await handleRetryCallback(tapCtx("retry:3f2a9c1e").ctx, deps);
    const second = tapCtx("retry:3f2a9c1e");
    await handleRetryCallback(second.ctx, deps);
    expect(runKernelText).toHaveBeenCalledTimes(1);
    expect(second.answers).toEqual([STALE_RETRY_TEXT]);
  });

  it("refuses a button from an older message once a newer turn has run", async () => {
    const { deps, runKernelText } = thread({ id: "aaaaaaaa-newer", raw_input: "something newer" });
    const { ctx, answers } = tapCtx("retry:3f2a9c1e");
    await handleRetryCallback(ctx, deps);
    expect(runKernelText).not.toHaveBeenCalled();
    expect(answers).toEqual([STALE_RETRY_TEXT]);
  });

  it("refuses a profile the registry no longer knows rather than running as the default", async () => {
    const { deps, runKernelText } = thread(FAILED);
    const { ctx, answers } = tapCtx("retry:3f2a9c1e:someone-removed");
    await handleRetryCallback(ctx, deps);
    expect(runKernelText).not.toHaveBeenCalled();
    expect(answers).toEqual([STALE_RETRY_TEXT]);
  });

  it("answers, never throws, when the checkpoint cannot be read (e.g. mid-restart)", async () => {
    const { deps, runKernelText } = thread(FAILED);
    deps.loadTurn = vi.fn(async () => {
      throw new Error("connection terminated");
    });
    const { ctx, answers } = tapCtx("retry:3f2a9c1e");
    await expect(handleRetryCallback(ctx, deps)).resolves.toBe(true);
    expect(runKernelText).not.toHaveBeenCalled();
    expect(answers[0]).toMatch(/couldn't load/i);
  });

  it("works on a card from before a restart: the turn comes from the checkpoint, not memory", async () => {
    // A fresh deps object stands in for a fresh process — nothing carried over
    // except what the checkpointer holds.
    const { deps, runKernelText } = thread(FAILED);
    await handleRetryCallback(tapCtx("retry:3f2a9c1e").ctx, deps);
    expect(runKernelText).toHaveBeenCalledTimes(1);
  });
});
