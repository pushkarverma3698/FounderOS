/**
 * Unit tests — the apply-from-phone buttons.
 *
 * The loop is two taps (📝 Draft, ✅ I applied). The buttons carry the row id,
 * not a brief number, so an old alert still names the company it was printed for.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Context } from "grammy";
import type { JobApplication } from "../../../src/db/schema.js";

const getApplicationById = vi.fn();
const updateApplicationStage = vi.fn();
const draftRow = vi.fn();
vi.mock("../../../src/db/apply-queries.js", () => ({ getApplicationById, listApplyQueue: vi.fn() }));
vi.mock("../../../src/db/job-queries.js", () => ({ updateApplicationStage }));
vi.mock("../../../src/gateway/jobhunt-commands.js", () => ({ draftRow }));

const {
  jobCallbackData,
  parseJobCallback,
  packetKeyboard,
  draftKeyboard,
  markRowApplied,
} = await import("../../../src/gateway/jobhunt-buttons.js");
const { handleJobCallback } = await import("../../../src/gateway/jobhunt-callbacks.js");

const ID = "0b9f1c52-3a4e-4d71-9c1e-5d2f7a8b6c10";
const ROW = {
  id: ID,
  company: "Ockto",
  title: "SRE",
  stage: "screened",
  applied_at: null,
  profile_id: "wife-nl-finance",
} as unknown as JobApplication;

function ctxFor(data: string) {
  const ctx = {
    callbackQuery: { data },
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    editMessageReplyMarkup: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
  };
  return ctx as unknown as Context & typeof ctx;
}

beforeEach(() => {
  vi.clearAllMocks();
  updateApplicationStage.mockResolvedValue({ ...ROW, stage: "applied" });
});

describe("callback data", () => {
  it("round-trips a row id and stays inside Telegram's 64-byte cap", () => {
    for (const action of ["draft", "applied"] as const) {
      const data = jobCallbackData(action, ID);
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
      expect(parseJobCallback(data)).toEqual({ action, rowId: ID });
    }
  });

  it("refuses payloads that are not ours or carry a malformed id", () => {
    for (const bad of ["approve:1", "jh:x:" + ID, "jh:a:not-a-uuid", "jh:a:", "jh:a:" + ID + "0"]) {
      expect(parseJobCallback(bad)).toBeNull();
    }
  });
});

describe("keyboards", () => {
  it("puts the form link and the I-applied button under a delivered CV", () => {
    const kb = packetKeyboard(ID, "https://x.example/apply").inline_keyboard.flat();
    expect(kb.map((b) => b.text)).toEqual(["🔗 Open the form", "✅ I applied"]);
    expect(kb[1]).toMatchObject({ callback_data: `jh:a:${ID}` });
  });

  it("leaves the form button out when there is no usable URL", () => {
    expect(packetKeyboard(ID, "").inline_keyboard.flat().map((b) => b.text)).toEqual(["✅ I applied"]);
    expect(packetKeyboard(ID, "javascript:alert(1)").inline_keyboard.flat()).toHaveLength(1);
  });

  it("labels each Draft button with its company", () => {
    const kb = draftKeyboard([{ id: ID, company: "Ockto" }]).inline_keyboard.flat();
    expect(kb[0]).toMatchObject({ text: "📝 Draft — Ockto", callback_data: `jh:d:${ID}` });
  });
});

describe("markRowApplied", () => {
  it("writes applied, starts the follow-up clock and drops the brief number", async () => {
    expect(await markRowApplied(ROW)).toEqual({ ok: true, already: false });
    expect(updateApplicationStage).toHaveBeenCalledWith(
      ID,
      "applied",
      expect.objectContaining({ appliedAt: expect.any(Date), lastContactAt: expect.any(Date), clearBriefRank: true }),
    );
  });

  it("is a no-op on a row already applied", async () => {
    expect(await markRowApplied({ ...ROW, stage: "applied" } as JobApplication)).toEqual({ ok: true, already: true });
    expect(updateApplicationStage).not.toHaveBeenCalled();
  });

  it("reports a failed write instead of claiming success", async () => {
    updateApplicationStage.mockResolvedValue(null);
    expect(await markRowApplied(ROW)).toEqual({ ok: false });
  });
});

describe("handleJobCallback", () => {
  const deps = { runKernelText: vi.fn() };

  it("passes through payloads that belong to another handler", async () => {
    const ctx = ctxFor("approve:abc");
    expect(await handleJobCallback(ctx, deps)).toBe(false);
    expect(ctx.answerCallbackQuery).not.toHaveBeenCalled();
  });

  it("✅ I applied marks the row, spends the button and confirms", async () => {
    getApplicationById.mockResolvedValue(ROW);
    const ctx = ctxFor(`jh:a:${ID}`);
    expect(await handleJobCallback(ctx, deps)).toBe(true);
    expect(updateApplicationStage).toHaveBeenCalledTimes(1);
    expect(ctx.editMessageReplyMarkup).toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("Marked applied — Ockto"));
  });

  it("a double tap writes once", async () => {
    getApplicationById.mockResolvedValue({ ...ROW, stage: "applied" });
    const ctx = ctxFor(`jh:a:${ID}`);
    await handleJobCallback(ctx, deps);
    expect(updateApplicationStage).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "Already marked applied" });
  });

  it("📝 Draft tailors for the ROW's candidate, not the chat's", async () => {
    getApplicationById.mockResolvedValue(ROW);
    const ctx = ctxFor(`jh:d:${ID}`);
    await handleJobCallback(ctx, deps);
    expect(draftRow).toHaveBeenCalledTimes(1);
    const [, row, , , profile] = draftRow.mock.calls[0] as [unknown, JobApplication, unknown, string, { id: string }];
    expect(row.id).toBe(ID);
    expect(profile.id).toBe("wife-nl-finance");
  });

  it("says so when the role is gone rather than failing silently", async () => {
    getApplicationById.mockResolvedValue(null);
    const ctx = ctxFor(`jh:d:${ID}`);
    await handleJobCallback(ctx, deps);
    expect(draftRow).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "That role is no longer on file." });
  });
});
