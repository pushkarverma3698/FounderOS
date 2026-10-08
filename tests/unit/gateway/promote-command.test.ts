/**
 * /promote (src/gateway/promote-command.ts): the card, the one tap that starts the job, and every way a tap is refused.
 * Nothing here touches the network, a socket or the database: the dependencies are injected.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Context } from "grammy";

vi.mock("../../../src/db/queries.js", () => ({ writeAuditEntry: vi.fn() }));

const { handlePromote, handlePromoteCallback, _resetPromoteClaimsForTests } = await import("../../../src/gateway/promote-command.js");
const { buildChatAccessConfig } = await import("../../../src/gateway/chat-access.js");

const SHA = "c".repeat(40);
const OWNER = 111;
const GUEST = 222;
const access = buildChatAccessConfig({ primaryChatId: String(OWNER), ownerUserId: String(OWNER), allowedChatIds: String(GUEST) });

const aheadCompare = {
  status: "ahead",
  ahead_by: 1,
  commits: [{ commit: { message: "Merge pull request #5 from o/b\n\nFix the thing" } }],
  files: [{ filename: "a.ts" }],
};

function makeDeps(over: Record<string, unknown> = {}) {
  return {
    read: vi.fn().mockResolvedValue({ betaSha: SHA, compare: aheadCompare }),
    start: vi.fn().mockResolvedValue({ status: "started" }),
    audit: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

function makeCtx(opts: { data?: string; from?: number; chat?: number } = {}) {
  const from = opts.from ?? OWNER;
  const chat = opts.chat ?? OWNER;
  return {
    chat: { id: chat, type: "private" },
    from: { id: from },
    callbackQuery: opts.data === undefined ? undefined : { data: opts.data, message: { message_id: 9 } },
    reply: vi.fn().mockResolvedValue(undefined),
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    editMessageText: vi.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => _resetPromoteClaimsForTests());

const asCtx = (c: ReturnType<typeof makeCtx>): Context => c as unknown as Context;

describe("handlePromote", () => {
  it("posts the card with Promote and Cancel, and starts nothing", async () => {
    const deps = makeDeps();
    const ctx = makeCtx();
    await handlePromote(asCtx(ctx), deps);

    expect(deps.start).not.toHaveBeenCalled();
    const [text, extra] = ctx.reply.mock.calls[0]!;
    expect(text).toContain("Promote 1 PR to prod?");
    expect(text).toContain("#5 Fix the thing");
    const row = extra.reply_markup.inline_keyboard[0];
    expect(row[0].callback_data).toBe(`pm:y:${SHA}`);
    expect(row[1].callback_data).toBe("pm:n");
  });

  it("says so, with no card, when there is nothing to promote", async () => {
    const deps = makeDeps({ read: vi.fn().mockResolvedValue({ betaSha: SHA, compare: { status: "identical", ahead_by: 0, commits: [], files: [] } }) });
    const ctx = makeCtx();
    await handlePromote(asCtx(ctx), deps);

    expect(ctx.reply).toHaveBeenCalledTimes(1);
    expect(ctx.reply.mock.calls[0]![0]).toContain("Nothing to promote");
    expect(ctx.reply.mock.calls[0]![1]).toBeUndefined();
  });

  it("reports an unreadable API instead of a card", async () => {
    const ctx = makeCtx();
    await handlePromote(asCtx(ctx), makeDeps({ read: vi.fn().mockRejectedValue(new Error("rate limited")) }));
    expect(ctx.reply.mock.calls[0]![0]).toContain("rate limited");
    expect(ctx.reply.mock.calls[0]![0]).toContain("Nothing was started");
  });
});

describe("handlePromoteCallback", () => {
  it("ignores buttons that are not promote buttons", async () => {
    const ctx = makeCtx({ data: "goal:p:1" });
    expect(await handlePromoteCallback(asCtx(ctx), access, makeDeps())).toBe(false);
    expect(ctx.answerCallbackQuery).not.toHaveBeenCalled();
  });

  it("refuses a guest before anything is read or started", async () => {
    const deps = makeDeps();
    const ctx = makeCtx({ data: `pm:y:${SHA}`, from: GUEST, chat: GUEST });
    expect(await handlePromoteCallback(asCtx(ctx), access, deps)).toBe(true);
    expect(deps.read).not.toHaveBeenCalled();
    expect(deps.start).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery.mock.calls[0]![0].text).toContain("Only the owner");
  });

  it("one tap on Promote hands the approved commit to the job and records it", async () => {
    const deps = makeDeps();
    const ctx = makeCtx({ data: `pm:y:${SHA}` });
    await handlePromoteCallback(asCtx(ctx), access, deps);

    expect(deps.start).toHaveBeenCalledWith(SHA);
    expect(deps.audit).toHaveBeenCalledWith(SHA, 9);
    expect(ctx.editMessageText.mock.calls[0]![0]).toContain("Promoting beta ccccccc");
  });

  it("a second tap on the same card starts nothing", async () => {
    const deps = makeDeps();
    await handlePromoteCallback(asCtx(makeCtx({ data: `pm:y:${SHA}` })), access, deps);
    await handlePromoteCallback(asCtx(makeCtx({ data: `pm:y:${SHA}` })), access, deps);
    expect(deps.start).toHaveBeenCalledTimes(1);
  });

  it("a stale card (beta moved) starts nothing and says what to do", async () => {
    const deps = makeDeps({ read: vi.fn().mockResolvedValue({ betaSha: "d".repeat(40), compare: aheadCompare }) });
    const ctx = makeCtx({ data: `pm:y:${SHA}` });
    await handlePromoteCallback(asCtx(ctx), access, deps);

    expect(deps.start).not.toHaveBeenCalled();
    expect(ctx.editMessageText.mock.calls[0]![0]).toContain("Beta moved to ddddddd");
  });

  it("a dead socket is reported in chat and the card can be tapped again", async () => {
    const start = vi.fn().mockResolvedValueOnce({ status: "failed", reason: "connect ENOENT" }).mockResolvedValueOnce({ status: "started" });
    const deps = makeDeps({ start });
    const first = makeCtx({ data: `pm:y:${SHA}` });
    await handlePromoteCallback(asCtx(first), access, deps);
    expect(first.reply.mock.calls[0]![0]).toContain("connect ENOENT");
    expect(deps.audit).not.toHaveBeenCalled();

    await handlePromoteCallback(asCtx(makeCtx({ data: `pm:y:${SHA}` })), access, deps);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("Cancel closes the card and starts nothing", async () => {
    const deps = makeDeps();
    const ctx = makeCtx({ data: "pm:n" });
    await handlePromoteCallback(asCtx(ctx), access, deps);
    expect(deps.start).not.toHaveBeenCalled();
    expect(ctx.editMessageText.mock.calls[0]![0]).toContain("cancelled");
  });

  it("a malformed Promote button is refused, not guessed at", async () => {
    const deps = makeDeps();
    const ctx = makeCtx({ data: "pm:y:abc;rm" });
    await handlePromoteCallback(asCtx(ctx), access, deps);
    expect(deps.start).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery.mock.calls[0]![0].text).toContain("not valid");
  });
});
