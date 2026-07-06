/**
 * TDD — UX improvement command handlers: /help, /ping, /departments (HITL annotations)
 * Track 4 — D1 fixes.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Context } from "grammy";

// ── Minimal grammy Context mock ───────────────────────────────────────────────

function fakeCtx(match = "", messageDate?: number): { ctx: Context; replies: string[] } {
  const replies: string[] = [];
  const ctx = {
    match,
    from: { first_name: "Pushkar" },
    chat: { id: 12345 },
    message: messageDate !== undefined ? { date: messageDate } : undefined,
    reply: vi.fn(async (msg: string) => {
      replies.push(msg);
    }),
  } as unknown as Context;
  return { ctx, replies };
}

// ── /help alias ───────────────────────────────────────────────────────────────

describe("handleHelp", () => {
  it("replies with content that contains 'commands' (same as /commands)", async () => {
    const { handleHelp } = await import("../../../src/gateway/commands.js");
    const { ctx, replies } = fakeCtx();
    await handleHelp(ctx);
    expect(replies.length).toBe(1);
    expect(replies[0].toLowerCase()).toMatch(/commands|help/i);
  });

  it("reply output matches handleCommands output exactly", async () => {
    const { handleHelp, handleCommands } = await import("../../../src/gateway/commands.js");
    const { ctx: helpCtx, replies: helpReplies } = fakeCtx();
    const { ctx: commandsCtx, replies: commandsReplies } = fakeCtx();

    await handleHelp(helpCtx);
    await handleCommands(commandsCtx);

    expect(helpReplies[0]).toBe(commandsReplies[0]);
  });

  it("includes at least one code tag for commands in the response", async () => {
    const { handleHelp } = await import("../../../src/gateway/commands.js");
    const { ctx, replies } = fakeCtx();
    await handleHelp(ctx);
    expect(replies[0]).toContain("<code>");
  });
});

// ── /ping health check ────────────────────────────────────────────────────────

describe("handlePing", () => {
  it("replies with 'alive' in the message", async () => {
    const { handlePing } = await import("../../../src/gateway/commands.js");
    const { ctx, replies } = fakeCtx("", Math.floor(Date.now() / 1000));
    await handlePing(ctx);
    expect(replies.length).toBe(1);
    expect(replies[0]).toMatch(/alive/i);
  });

  it("replies with FounderOS name in the message", async () => {
    const { handlePing } = await import("../../../src/gateway/commands.js");
    const { ctx, replies } = fakeCtx("", Math.floor(Date.now() / 1000));
    await handlePing(ctx);
    expect(replies[0]).toContain("FounderOS");
  });

  it("includes latency in milliseconds", async () => {
    const { handlePing } = await import("../../../src/gateway/commands.js");
    // date = 1 second ago
    const messageDate = Math.floor(Date.now() / 1000) - 1;
    const { ctx, replies } = fakeCtx("", messageDate);
    await handlePing(ctx);
    expect(replies[0]).toContain("ms");
  });

  it("does not throw when ctx.message is undefined", async () => {
    const { handlePing } = await import("../../../src/gateway/commands.js");
    const { ctx, replies } = fakeCtx("", undefined);
    await expect(handlePing(ctx)).resolves.toBeUndefined();
    expect(replies.length).toBe(1);
    expect(replies[0]).toMatch(/alive/i);
  });

  it("does not require runOfficeText (instant response)", async () => {
    const { handlePing } = await import("../../../src/gateway/commands.js");
    const { ctx, replies } = fakeCtx("", Math.floor(Date.now() / 1000));
    // handlePing takes only ctx — no second arg needed
    await handlePing(ctx);
    expect(replies.length).toBe(1);
  });
});

// ── /departments HITL annotations ─────────────────────────────────────────────

describe("handleDepartments", () => {
  it("output contains ✋ for at least one HITL-gated tool", async () => {
    const { handleDepartments } = await import("../../../src/gateway/commands.js");
    const { ctx, replies } = fakeCtx();
    await handleDepartments(ctx);
    expect(replies.length).toBe(1);
    expect(replies[0]).toContain("✋");
  });

  it("shows ✋ for send_email (HITL-gated)", async () => {
    const { handleDepartments } = await import("../../../src/gateway/commands.js");
    const { ctx, replies } = fakeCtx();
    await handleDepartments(ctx);
    expect(replies[0]).toMatch(/send_email.*✋|✋.*send_email/);
  });

  it("shows ✋ for linkedin_post (HITL-gated)", async () => {
    const { handleDepartments } = await import("../../../src/gateway/commands.js");
    const { ctx, replies } = fakeCtx();
    await handleDepartments(ctx);
    expect(replies[0]).toMatch(/linkedin_post.*✋|✋.*linkedin_post/);
  });

  it("shows ✋ for github_write (HITL-gated)", async () => {
    const { handleDepartments } = await import("../../../src/gateway/commands.js");
    const { ctx, replies } = fakeCtx();
    await handleDepartments(ctx);
    expect(replies[0]).toMatch(/github_write.*✋|✋.*github_write/);
  });

  it("search_web does NOT have ✋ immediately after it (not HITL-gated)", async () => {
    const { handleDepartments } = await import("../../../src/gateway/commands.js");
    const { ctx, replies } = fakeCtx();
    await handleDepartments(ctx);
    expect(replies[0]).not.toMatch(/search_web✋/);
  });

  it("includes a legend explaining ✋ means approval required", async () => {
    const { handleDepartments } = await import("../../../src/gateway/commands.js");
    const { ctx, replies } = fakeCtx();
    await handleDepartments(ctx);
    expect(replies[0]).toMatch(/✋.*appro|appro.*✋/i);
  });
});

// ── /start updated welcome message ────────────────────────────────────────────

describe("handleStart", () => {
  it("shows product capability guide", async () => {
    const { handleStart } = await import("../../../src/gateway/commands.js");
    const { ctx, replies } = fakeCtx();
    await handleStart(ctx);
    expect(replies[0]).toContain("What you can do");
    expect(replies[0]).toContain("Admin");
    expect(replies[0]).toContain("Jobhunt");
  });

  it("mentions /help in the welcome message", async () => {
    const { handleStart } = await import("../../../src/gateway/commands.js");
    const { ctx, replies } = fakeCtx();
    await handleStart(ctx);
    expect(replies[0]).toContain("/help");
  });

  it("mentions /ping in the welcome message", async () => {
    const { handleStart } = await import("../../../src/gateway/commands.js");
    const { ctx, replies } = fakeCtx();
    await handleStart(ctx);
    expect(replies[0]).toContain("/ping");
  });
});

// ── /subagent (ADR-046) — plan → approve → execute ────────────────────────────

describe("buildSubagentBrief — pure execution brief", () => {
  it("embeds the approved plan when present", async () => {
    const { buildSubagentBrief } = await import("../../../src/gateway/commands.js");
    const brief = buildSubagentBrief("build a todo CLI", "1. scaffold\n2. tests");
    expect(brief).toContain("build a todo CLI");
    expect(brief).toContain("APPROVED IMPLEMENTATION PLAN");
    expect(brief).toContain("1. scaffold");
    expect(brief).toContain("claude_code");
  });

  it("omits the plan section when no plan is available", async () => {
    const { buildSubagentBrief } = await import("../../../src/gateway/commands.js");
    const brief = buildSubagentBrief("build a todo CLI", null);
    expect(brief).toContain("build a todo CLI");
    expect(brief).not.toContain("APPROVED IMPLEMENTATION PLAN");
  });

  it("treats a blank plan string as no plan", async () => {
    const { buildSubagentBrief } = await import("../../../src/gateway/commands.js");
    expect(buildSubagentBrief("x", "   ")).not.toContain("APPROVED IMPLEMENTATION PLAN");
  });
});

describe("handleSubagent — plan → approve → execute flow", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("empty task → shows usage, never plans or dispatches", async () => {
    const { handleSubagent } = await import("../../../src/gateway/commands.js");
    const { claudeCodeTool } = await import("../../../src/tools/claude-code.js");
    const spy = vi.spyOn(claudeCodeTool, "execute");
    const { ctx, replies } = fakeCtx("");
    const dispatched: string[] = [];
    await handleSubagent(ctx, async (_c, text) => { dispatched.push(text); });
    expect(replies[0]).toContain("/subagent");
    expect(spy).not.toHaveBeenCalled();
    expect(dispatched).toHaveLength(0);
  });

  it("plan success → surfaces the plan and dispatches a plan-embedded brief", async () => {
    const { handleSubagent } = await import("../../../src/gateway/commands.js");
    const { claudeCodeTool } = await import("../../../src/tools/claude-code.js");
    vi.spyOn(claudeCodeTool, "execute").mockResolvedValue({ success: true, data: "1. scaffold\n2. add tests" });
    const { ctx, replies } = fakeCtx("build a todo CLI");
    const dispatched: string[] = [];
    await handleSubagent(ctx, async (_c, text) => { dispatched.push(text); });
    expect(claudeCodeTool.execute).toHaveBeenCalledWith(expect.objectContaining({ mode: "plan" }));
    expect(replies.some((r) => r.includes("Implementation plan"))).toBe(true);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toContain("APPROVED IMPLEMENTATION PLAN");
    expect(dispatched[0]).toContain("scaffold");
  });

  it("plan failure → graceful fallback, still dispatches a no-plan brief", async () => {
    const { handleSubagent } = await import("../../../src/gateway/commands.js");
    const { claudeCodeTool } = await import("../../../src/tools/claude-code.js");
    vi.spyOn(claudeCodeTool, "execute").mockResolvedValue({ success: false, error: "CLI not found" });
    const { ctx, replies } = fakeCtx("build a todo CLI");
    const dispatched: string[] = [];
    await handleSubagent(ctx, async (_c, text) => { dispatched.push(text); });
    expect(replies.some((r) => r.includes("Planning step unavailable"))).toBe(true);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).not.toContain("APPROVED IMPLEMENTATION PLAN");
    expect(dispatched[0]).toContain("build a todo CLI");
  });
});
