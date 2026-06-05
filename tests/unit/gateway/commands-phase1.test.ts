/**
 * TDD — Phase 1 command handlers: handleRun, handleQ, handleWorkflows
 * RED: write and watch fail before fixing error paths.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Context } from "grammy";
import { handleRun, handleQ, handleWorkflows } from "../../../src/gateway/commands.js";

// ── Minimal grammy Context mock ───────────────────────────────────────────────

function fakeCtx(match: string): { ctx: Context; replies: string[] } {
  const replies: string[] = [];
  const ctx = {
    match,
    reply: vi.fn(async (msg: string) => { replies.push(msg); }),
    chat: { id: 12345 },
  } as unknown as Context;
  return { ctx, replies };
}

const noop = async () => {};

// ── handleWorkflows ───────────────────────────────────────────────────────────

describe("handleWorkflows", () => {
  it("replies with workflow list including all workflow ids", async () => {
    const { ctx, replies } = fakeCtx("");
    await handleWorkflows(ctx);
    expect(replies.length).toBeGreaterThan(0);
    expect(replies[0]).toContain("onboarding");
    expect(replies[0]).toContain("outbound");
    expect(replies[0]).toContain("weekly_digest");
  });

  it("shows step labels for each workflow", async () => {
    const { ctx, replies } = fakeCtx("");
    await handleWorkflows(ctx);
    // onboarding has "ICP score" step
    expect(replies[0]).toContain("ICP score");
  });
});

// ── handleRun ─────────────────────────────────────────────────────────────────

describe("handleRun — input validation", () => {
  it("replies with usage when called with no args", async () => {
    const { ctx, replies } = fakeCtx("");
    await handleRun(ctx, noop as any);
    expect(replies[0]).toContain("/run");
    expect(replies[0]).toContain("workflow");
  });

  it("replies with error when workflow id is unknown", async () => {
    const { ctx, replies } = fakeCtx("nonexistent company=Acme");
    await handleRun(ctx, noop as any);
    expect(replies[0]).toContain("nonexistent");
    expect(replies[0]).toMatch(/unknown/i);
  });

  it("replies with error when required params are missing", async () => {
    const { ctx, replies } = fakeCtx("onboarding");
    await handleRun(ctx, noop as any);
    // onboarding requires 'company'
    expect(replies[0]).toContain("company");
    expect(replies[0]).toMatch(/missing/i);
  });
});

describe("handleRun — workflow execution", () => {
  it("runs a valid workflow and sends progress messages", async () => {
    const { ctx, replies } = fakeCtx("weekly_digest");
    const runStep = vi.fn(async () => {});
    await handleRun(ctx, runStep as any);
    // Should have sent at least intro + step messages
    expect(replies.length).toBeGreaterThan(1);
    // runStep should have been called for each of weekly_digest's 3 steps
    expect(runStep).toHaveBeenCalledTimes(3);
  });

  it("does not throw when ctx.reply fails mid-workflow (graceful error handling)", async () => {
    // This is the real bug: if ctx.reply throws inside sendStatus, handleRun
    // currently propagates the error. It should catch it and send a fallback error
    // message — but since ctx.reply itself is failing, just not throwing is the minimum bar.
    const replies: string[] = [];
    let replyCount = 0;
    const ctx = {
      match: "weekly_digest",
      reply: vi.fn(async (msg: string) => {
        replyCount++;
        if (replyCount === 2) throw new Error("Telegram API unavailable");
        replies.push(msg);
      }),
      chat: { id: 12345 },
    } as unknown as Context;

    // Should not throw — error should be caught internally
    await expect(handleRun(ctx, noop as any)).resolves.toBeUndefined();
  });
});

// ── handleQ ───────────────────────────────────────────────────────────────────

describe("handleQ — input validation", () => {
  it("replies with usage when called with no args", async () => {
    const { ctx, replies } = fakeCtx("");
    await handleQ(ctx, noop as any);
    expect(replies[0]).toContain("/q");
    expect(replies[0]).toContain("department");
  });

  it("replies with error when only dept given, no task", async () => {
    const { ctx, replies } = fakeCtx("research");
    await handleQ(ctx, noop as any);
    expect(replies[0]).toMatch(/missing task/i);
  });

  it("replies with error for an unknown department", async () => {
    const { ctx, replies } = fakeCtx("finance do my taxes");
    await handleQ(ctx, noop as any);
    expect(replies[0]).toContain("finance");
    expect(replies[0]).toMatch(/unknown department/i);
  });
});

describe("handleQ — routing", () => {
  it("calls runOfficeText with the routing hint prefix for a valid dept + task", async () => {
    const { ctx } = fakeCtx("research what does Stripe do?");
    const runStep = vi.fn(async () => {});
    await handleQ(ctx, runStep as any);
    expect(runStep).toHaveBeenCalledTimes(1);
    const calledWith = (runStep.mock.calls[0] as [Context, string])[1];
    expect(calledWith).toContain("[Route directly to research department]");
    expect(calledWith).toContain("what does Stripe do?");
  });

  it("accepts all 7 valid departments without error", async () => {
    // prospecting merged into research (2026-06-05)
    const depts = ["research", "comms", "engineering", "marketing", "sales", "personal", "jobhunt"];
    for (const dept of depts) {
      const { ctx, replies } = fakeCtx(`${dept} do something`);
      const runStep = vi.fn(async () => {});
      await handleQ(ctx, runStep as any);
      expect(replies.length).toBe(0); // no error replies
      expect(runStep).toHaveBeenCalledTimes(1);
    }
  });
});
