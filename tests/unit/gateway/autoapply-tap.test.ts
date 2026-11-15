import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";

const writeRuntimeSwitch = vi.fn(async () => undefined);
vi.mock("../../../src/tools/jobhunt/auto-send-switch.js", () => ({ readRuntimeSwitch: vi.fn(async () => true), writeRuntimeSwitch }));
vi.mock("../../../src/db/job-auto-send-queries.js", () => ({
  loadAutoSendHistory: vi.fn(async () => ({ sentToday: 2 })),
  recentAutoSends: vi.fn(async () => []),
}));

const { handleAutoApplyTap } = await import("../../../src/gateway/autoapply-command.js");
const { listProfiles } = await import("../../../src/tools/jobhunt/profile-config.js");

function fakeCtx() {
  const answerCallbackQuery = vi.fn(async () => true);
  const editMessageText = vi.fn(async () => true);
  return { ctx: { answerCallbackQuery, editMessageText } as unknown as Context, answerCallbackQuery, editMessageText };
}

describe("handleAutoApplyTap", () => {
  beforeEach(() => writeRuntimeSwitch.mockClear());

  it("writes the switch, toasts and redraws the status in place", async () => {
    const id = listProfiles()[0]!.id;
    const { ctx, answerCallbackQuery, editMessageText } = fakeCtx();
    await handleAutoApplyTap(ctx, { verb: "off", profileId: id });
    expect(writeRuntimeSwitch).toHaveBeenCalledWith(id, false);
    expect(answerCallbackQuery).toHaveBeenCalledWith({ text: "Auto-apply off" });
    expect(editMessageText).toHaveBeenCalledTimes(1);
  });

  it("refresh writes nothing", async () => {
    const { ctx } = fakeCtx();
    await handleAutoApplyTap(ctx, { verb: "status", profileId: listProfiles()[0]!.id });
    expect(writeRuntimeSwitch).not.toHaveBeenCalled();
  });

  it("an unknown profile is refused without writing", async () => {
    const { ctx, answerCallbackQuery, editMessageText } = fakeCtx();
    await handleAutoApplyTap(ctx, { verb: "on", profileId: "nobody" });
    expect(writeRuntimeSwitch).not.toHaveBeenCalled();
    expect(answerCallbackQuery).toHaveBeenCalledWith({ text: "That button is out of date." });
    expect(editMessageText).not.toHaveBeenCalled();
  });
});
