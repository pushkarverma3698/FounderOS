/**
 * Telegram entry points to the Mini App job list: bare /apply and the jobs bot menu button.
 *  1. `/apply` with no argument in a private chat replies with a web_app button to /apply/home.
 *  2. In a group (negative chat id), or without a configured https link, it keeps today's usage reply.
 *  3. `/apply 1` still resolves a row; `/wife_apply` (forced profile) with no argument also gets the button.
 *  4. The menu button is set only for a positive TELEGRAM_CHAT_ID and a valid link config, and a Telegram refusal is a warning.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockResolveRowRef = vi.fn();
vi.mock("../../../src/infra/logger.js", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("../../../src/gateway/jobhunt-row-ref.js", async (orig) => ({
  ...(await orig<typeof import("../../../src/gateway/jobhunt-row-ref.js")>()),
  resolveRowRef: (...a: unknown[]) => mockResolveRowRef(...a),
}));

const { handleAutoApply } = await import("../../../src/gateway/auto-apply.js");
const { publishApplyMenuButton } = await import("../../../src/gateway/apply-menu-button.js");
const { applyHomeUrl } = await import("../../../src/gateway/apply-home.js");

const SECRET = "s3cret-for-tests-0123456789abcdef";
const HOME = "https://apply.example.test/apply/home";

function ctx(match: string, chatId: number) {
  return { chat: { id: chatId, type: chatId > 0 ? "private" : "supergroup" }, match, reply: vi.fn(async (..._a: unknown[]) => undefined) };
}

describe("/apply with no argument", () => {
  beforeEach(() => {
    process.env["APPLY_LINK_SECRET"] = SECRET;
    process.env["APPLY_LINK_BASE_URL"] = "https://apply.example.test";
    mockResolveRowRef.mockReset();
  });
  afterEach(() => {
    delete process.env["APPLY_LINK_SECRET"];
    delete process.env["APPLY_LINK_BASE_URL"];
  });

  it("opens the job list from a private chat with a web_app button", async () => {
    const c = ctx("", 111);
    await handleAutoApply(c as never);
    expect(c.reply).toHaveBeenCalledTimes(1);
    const extra = c.reply.mock.calls[0]?.[1] as { reply_markup: { inline_keyboard: Array<Array<{ web_app?: { url: string } }>> } };
    expect(extra.reply_markup.inline_keyboard[0]?.[0]?.web_app?.url).toBe(HOME);
  });

  it("gives the profile-forced twin the same button", async () => {
    const c = ctx("wife", 111);
    await handleAutoApply(c as never);
    const extra = c.reply.mock.calls[0]?.[1] as { reply_markup?: unknown };
    expect(extra.reply_markup).toBeDefined();
  });

  it("keeps the usage reply in a group, where a web_app button is not allowed", async () => {
    const c = ctx("", -100123);
    await handleAutoApply(c as never);
    expect(c.reply).toHaveBeenCalledTimes(1);
    expect(String(c.reply.mock.calls[0]?.[0])).toContain("Usage: /apply");
    expect(c.reply.mock.calls[0]?.[1]).toBeUndefined();
  });

  it("keeps the usage reply when the link is not configured or not https", async () => {
    delete process.env["APPLY_LINK_SECRET"];
    const c = ctx("", 111);
    await handleAutoApply(c as never);
    expect(String(c.reply.mock.calls[0]?.[0])).toContain("Usage: /apply");
    process.env["APPLY_LINK_SECRET"] = SECRET;
    process.env["APPLY_LINK_BASE_URL"] = "http://apply.example.test";
    const d = ctx("", 111);
    await handleAutoApply(d as never);
    expect(String(d.reply.mock.calls[0]?.[0])).toContain("Usage: /apply");
  });

  it("still resolves a row number", async () => {
    mockResolveRowRef.mockResolvedValue({ ok: false, message: "No row 3 in the latest brief" });
    const c = ctx("3", 111);
    await handleAutoApply(c as never);
    expect(mockResolveRowRef).toHaveBeenCalledTimes(1);
    expect(c.reply).toHaveBeenCalledWith("No row 3 in the latest brief");
  });
});

describe("applyHomeUrl", () => {
  it("is null until the link config is complete", () => {
    expect(applyHomeUrl({})).toBeNull();
    expect(applyHomeUrl({ APPLY_LINK_SECRET: SECRET, APPLY_LINK_BASE_URL: "https://apply.example.test" })).toBe(HOME);
  });
});

describe("publishApplyMenuButton", () => {
  const env = { APPLY_LINK_SECRET: SECRET, APPLY_LINK_BASE_URL: "https://apply.example.test", TELEGRAM_CHAT_ID: "111" };

  it("sets a web_app menu button for the founder's private chat", async () => {
    const api = { setChatMenuButton: vi.fn(async (..._a: unknown[]) => true) };
    expect(await publishApplyMenuButton(api, env)).toBe("set");
    expect(api.setChatMenuButton).toHaveBeenCalledWith({ chat_id: 111, menu_button: { type: "web_app", text: "Jobs", web_app: { url: HOME } } });
  });

  it("skips a group chat id, a missing chat id and an incomplete link config", async () => {
    const api = { setChatMenuButton: vi.fn(async (..._a: unknown[]) => true) };
    expect(await publishApplyMenuButton(api, { ...env, TELEGRAM_CHAT_ID: "-100123" })).toBe("skipped");
    expect(await publishApplyMenuButton(api, { ...env, TELEGRAM_CHAT_ID: undefined })).toBe("skipped");
    expect(await publishApplyMenuButton(api, { ...env, APPLY_LINK_SECRET: undefined })).toBe("skipped");
    expect(await publishApplyMenuButton(api, { ...env, APPLY_LINK_BASE_URL: "http://apply.example.test" })).toBe("skipped");
    expect(api.setChatMenuButton).not.toHaveBeenCalled();
  });

  it("does not throw when Telegram refuses", async () => {
    const api = { setChatMenuButton: vi.fn(async (..._a: unknown[]) => { throw new Error("Bad Request"); }) };
    expect(await publishApplyMenuButton(api, env)).toBe("skipped");
  });
});
