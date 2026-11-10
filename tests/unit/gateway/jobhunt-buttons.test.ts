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
const markSkipped = vi.fn();
vi.mock("../../../src/db/apply-queries.js", () => ({ getApplicationById, listApplyQueue: vi.fn(), markSkipped }));
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
  skipped_at: null,
  tenant_id: "turicks",
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
  markSkipped.mockResolvedValue(1);
});

describe("callback data", () => {
  it("round-trips a row id and stays inside Telegram's 64-byte cap", () => {
    for (const action of ["draft", "applied", "skipped"] as const) {
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
  it("passes through payloads that belong to another handler", async () => {
    const ctx = ctxFor("approve:abc");
    expect(await handleJobCallback(ctx)).toBe(false);
    expect(ctx.answerCallbackQuery).not.toHaveBeenCalled();
  });

  it("✅ I applied marks the row, spends the button and confirms", async () => {
    getApplicationById.mockResolvedValue(ROW);
    const ctx = ctxFor(`jh:a:${ID}`);
    expect(await handleJobCallback(ctx)).toBe(true);
    expect(updateApplicationStage).toHaveBeenCalledTimes(1);
    expect(ctx.editMessageReplyMarkup).toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("Marked applied — Ockto"));
  });

  describe("in a digest (several roles under one message)", () => {
    const OTHER = "1c9f1c52-3a4e-4d71-9c1e-5d2f7a8b6c11";
    const digestCtx = (data: string) => {
      const ctx = ctxFor(data) as ReturnType<typeof ctxFor> & { callbackQuery: Record<string, unknown> };
      ctx.callbackQuery["message"] = ({
        reply_markup: {
          inline_keyboard: [
            [{ text: "📝 Draft 1", callback_data: `jh:d:${ID}` }, { text: "✅ Applied 1", callback_data: `jh:a:${ID}` }, { text: "⏭ Skip 1", callback_data: `jh:n:${ID}` }],
            [{ text: "📝 Draft 2", callback_data: `jh:d:${OTHER}` }, { text: "✅ Applied 2", callback_data: `jh:a:${OTHER}` }, { text: "⏭ Skip 2", callback_data: `jh:n:${OTHER}` }],
          ],
        },
      } as never);
      return ctx;
    };

    it("✅ records applied for THAT row only, names whose it is, and keeps the other role's buttons", async () => {
      getApplicationById.mockResolvedValue(ROW);
      const ctx = digestCtx(`jh:a:${ID}`);
      await handleJobCallback(ctx);
      expect(updateApplicationStage).toHaveBeenCalledTimes(1);
      expect(updateApplicationStage.mock.calls[0]?.[0]).toBe(ID);
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "✅ Marked applied — Ockto (Tashi)" });
      const kb = (ctx.editMessageReplyMarkup.mock.calls[0]?.[0] as { reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } }).reply_markup.inline_keyboard;
      expect(kb[0]?.map((b) => b.text)).toEqual(["✅ Applied — Ockto"]);
      expect(kb[1]?.map((b) => b.callback_data)).toEqual([`jh:d:${OTHER}`, `jh:a:${OTHER}`, `jh:n:${OTHER}`]);
      expect(ctx.reply).not.toHaveBeenCalled();
    });

    it("⏭ Skip stamps skipped_at on that row (not applied) and clears its brief slot", async () => {
      getApplicationById.mockResolvedValue(ROW);
      const ctx = digestCtx(`jh:n:${ID}`);
      await handleJobCallback(ctx);
      expect(markSkipped).toHaveBeenCalledWith([ID], "turicks", { clearBrief: true });
      expect(updateApplicationStage).not.toHaveBeenCalled();
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "⏭ Skipped — Ockto (Tashi)" });
    });

    it("a skip tap on a role already applied to changes nothing and says so", async () => {
      getApplicationById.mockResolvedValue({ ...ROW, stage: "applied", applied_at: new Date() });
      const ctx = digestCtx(`jh:n:${ID}`);
      await handleJobCallback(ctx);
      expect(markSkipped).not.toHaveBeenCalled();
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "Already marked applied (Tashi)" });
    });

    it("a second skip tap writes nothing", async () => {
      getApplicationById.mockResolvedValue({ ...ROW, skipped_at: new Date() });
      await handleJobCallback(digestCtx(`jh:n:${ID}`));
      expect(markSkipped).not.toHaveBeenCalled();
    });

    it("looks the row up by the button's own id only: no other row can be touched by this tap", async () => {
      getApplicationById.mockResolvedValue(ROW);
      await handleJobCallback(digestCtx(`jh:a:${ID}`));
      expect(getApplicationById).toHaveBeenCalledTimes(1);
      expect(getApplicationById.mock.calls[0]?.[0]).toBe(ID);
    });
  });

  it("a double tap writes once", async () => {
    getApplicationById.mockResolvedValue({ ...ROW, stage: "applied" });
    const ctx = ctxFor(`jh:a:${ID}`);
    await handleJobCallback(ctx);
    expect(updateApplicationStage).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "Already marked applied (Tashi)" });
  });

  it("📝 Draft tailors for the ROW's candidate, not the chat's", async () => {
    getApplicationById.mockResolvedValue(ROW);
    const ctx = ctxFor(`jh:d:${ID}`);
    await handleJobCallback(ctx);
    expect(draftRow).toHaveBeenCalledTimes(1);
    const [, row, , profile] = draftRow.mock.calls[0] as [unknown, JobApplication, unknown, { id: string }];
    expect(row.id).toBe(ID);
    expect(profile.id).toBe("wife-nl-finance");
  });

  it("says so when the role is gone rather than failing silently", async () => {
    getApplicationById.mockResolvedValue(null);
    const ctx = ctxFor(`jh:d:${ID}`);
    await handleJobCallback(ctx);
    expect(draftRow).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "That role is no longer on file." });
  });
});
