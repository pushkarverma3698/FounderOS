/**
 * The job lane has its own chat. Until 2026-10-02 every sweep alert, pipeline digest, follow-up nudge and
 * the 09:30 check, for BOTH candidates, arrived in the founder's private chat, mixed with budget alerts,
 * dispatch notices and approvals, and the wife, who works the second profile, saw none of hers.
 * `JOBHUNT_CHAT_ID` points the job lane at the family jobs group. Unset, it falls back to the founder's
 * chat, so nothing moves until the variable is set on the box.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const sendMessage = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({ message_id: 1 })));
vi.mock("grammy", () => ({
  Bot: class {
    api = { sendMessage };
  },
  InputFile: class {},
}));

import { env } from "../../../src/core/config.js";
import { isChatUnreachable, jobsChatId, sendToChat, sendToJobsChat } from "../../../src/infra/telegram-send.js";

const FOUNDER = env.TELEGRAM_CHAT_ID;
const GROUP = "-1009876543210";

/** What grammy throws for a Telegram refusal: the Bot API's error_code and description, plus parameters when given. */
const refusal = (error_code: number, description: string, parameters?: { migrate_to_chat_id?: number }) =>
  Object.assign(new Error(`Call to 'sendMessage' failed! (${error_code}: ${description})`), {
    error_code,
    description,
    parameters,
  });

const originalJobsChat = process.env["JOBHUNT_CHAT_ID"];
beforeEach(() => {
  sendMessage.mockReset();
  sendMessage.mockResolvedValue({ message_id: 1 });
  process.env["JOBHUNT_CHAT_ID"] = GROUP;
});
afterEach(() => {
  if (originalJobsChat === undefined) delete process.env["JOBHUNT_CHAT_ID"];
  else process.env["JOBHUNT_CHAT_ID"] = originalJobsChat;
});

describe("jobsChatId", () => {
  it("is JOBHUNT_CHAT_ID when it is set", () => {
    expect(jobsChatId()).toBe(GROUP);
  });

  it("falls back to the founder's chat when it is not set, so a deploy changes nothing until the box has the variable", () => {
    delete process.env["JOBHUNT_CHAT_ID"];
    expect(jobsChatId()).toBe(FOUNDER);
  });

  it("treats an empty or blank value as unset: a bare `JOBHUNT_CHAT_ID=` line must not send to chat ''", () => {
    process.env["JOBHUNT_CHAT_ID"] = "";
    expect(jobsChatId()).toBe(FOUNDER);
    process.env["JOBHUNT_CHAT_ID"] = "   ";
    expect(jobsChatId()).toBe(FOUNDER);
  });

  it("trims stray whitespace around the id", () => {
    process.env["JOBHUNT_CHAT_ID"] = `  ${GROUP}\n`;
    expect(jobsChatId()).toBe(GROUP);
  });
});

describe("sendToJobsChat", () => {
  it("posts to the jobs group, as HTML by default (the job formatters emit HTML)", async () => {
    await sendToJobsChat("🆕 3 new roles");
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(GROUP, "🆕 3 new roles", { parse_mode: "HTML" });
  });

  it("honours an explicit parse mode", async () => {
    await sendToJobsChat("*3 new roles*", "Markdown");
    expect(sendMessage).toHaveBeenCalledWith(GROUP, "*3 new roles*", { parse_mode: "Markdown" });
  });

  it("goes to the founder's chat when no jobs chat is configured", async () => {
    delete process.env["JOBHUNT_CHAT_ID"];
    await sendToJobsChat("🆕 3 new roles");
    expect(sendMessage).toHaveBeenCalledWith(FOUNDER, "🆕 3 new roles", { parse_mode: "HTML" });
  });
});

describe("sendToChat: the system channel does not move", () => {
  it("still goes to TELEGRAM_CHAT_ID when JOBHUNT_CHAT_ID is set, so approvals and alerts stay with the founder", async () => {
    await sendToChat("⏳ Approval still pending");
    expect(sendMessage).toHaveBeenCalledWith(FOUNDER, "⏳ Approval still pending", { parse_mode: "HTML" });
  });
});

describe("a jobs group that cannot be reached", () => {
  it("falls back to the founder's chat, notice first, and the job message is not lost", async () => {
    sendMessage.mockRejectedValueOnce(refusal(403, "Forbidden: bot was kicked from the supergroup chat"));

    await sendToJobsChat("🆕 3 new roles");

    expect(sendMessage).toHaveBeenCalledTimes(3);
    const notice = sendMessage.mock.calls[1]!;
    expect(notice[0]).toBe(FOUNDER);
    expect(String(notice[1])).toContain("jobs group");
    expect(String(notice[1])).toContain("bot was kicked");
    // Plain text: the reason comes from Telegram, so it must not be able to break an HTML parse.
    expect(notice).toHaveLength(2);
    expect(sendMessage.mock.calls[2]).toEqual([FOUNDER, "🆕 3 new roles", { parse_mode: "HTML" }]);
  });

  it("names the group's new id when Telegram upgraded it to a supergroup, which changes the chat id", async () => {
    sendMessage.mockRejectedValueOnce(
      refusal(400, "Bad Request: group chat was upgraded to a supergroup chat", { migrate_to_chat_id: -1001111222233 }),
    );

    await sendToJobsChat("x");

    expect(String(sendMessage.mock.calls[1]![1])).toContain("-1001111222233");
    expect(String(sendMessage.mock.calls[1]![1])).toContain("JOBHUNT_CHAT_ID");
  });

  it("does not fall back on a bad message, which would fail in the founder's chat too", async () => {
    sendMessage.mockRejectedValueOnce(refusal(400, "Bad Request: can't parse entities: Unsupported start tag"));
    await expect(sendToJobsChat("<b>x")).rejects.toThrow(/parse entities/);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("does not fall back on a rate limit or an outage: the callers already retry those", async () => {
    sendMessage.mockRejectedValueOnce(refusal(429, "Too Many Requests: retry after 5"));
    await expect(sendToJobsChat("x")).rejects.toThrow(/429/);
    sendMessage.mockRejectedValueOnce(new Error("socket hang up"));
    await expect(sendToJobsChat("x")).rejects.toThrow(/socket hang up/);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it("has nowhere to fall back to when the jobs chat is the founder's own chat", async () => {
    process.env["JOBHUNT_CHAT_ID"] = FOUNDER;
    sendMessage.mockRejectedValueOnce(refusal(403, "Forbidden: bot was blocked by the user"));
    await expect(sendToJobsChat("x")).rejects.toThrow(/403/);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("lets a failure of the fallback itself reach the caller", async () => {
    sendMessage
      .mockRejectedValueOnce(refusal(403, "Forbidden: bot was kicked from the supergroup chat"))
      .mockRejectedValueOnce(new Error("Bad Gateway"));
    await expect(sendToJobsChat("x")).rejects.toThrow("Bad Gateway");
  });
});

describe("isChatUnreachable", () => {
  it.each([
    [403, "Forbidden: bot was kicked from the group chat"],
    [403, "Forbidden: bot is not a member of the supergroup chat"],
    [400, "Bad Request: chat not found"],
    [400, "Bad Request: group chat was upgraded to a supergroup chat"],
    [400, "Bad Request: have no rights to send a message"],
    [400, "Bad Request: Have no write access to the chat"],
  ])("%i %s: the chat cannot be reached", (code, description) => {
    expect(isChatUnreachable(refusal(code, description))).toBe(true);
  });

  it.each([
    [400, "Bad Request: can't parse entities: Unsupported start tag"],
    [400, "Bad Request: message is too long"],
    [429, "Too Many Requests: retry after 3"],
    [502, "Bad Gateway"],
  ])("%i %s: not a problem with the chat", (code, description) => {
    expect(isChatUnreachable(refusal(code, description))).toBe(false);
  });

  it("is false for a plain Error and for anything that is not an error", () => {
    expect(isChatUnreachable(new Error("socket hang up"))).toBe(false);
    expect(isChatUnreachable("403")).toBe(false);
    expect(isChatUnreachable(undefined)).toBe(false);
    expect(isChatUnreachable(null)).toBe(false);
  });
});
