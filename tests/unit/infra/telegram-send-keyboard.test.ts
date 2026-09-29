/**
 * sendToChatWithKeyboard: the api-only send the goal standup uses for its "Plan next step" buttons
 * (`sendToChat` takes no keyboard). Never polls, so it cannot conflict with the gateway's getUpdates.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const sendMessage = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({ message_id: 1 })));
vi.mock("grammy", () => ({
  Bot: class {
    api = { sendMessage };
  },
  InputFile: class {},
}));

import { sendToChatWithKeyboard } from "../../../src/infra/telegram-send.js";

beforeEach(() => sendMessage.mockClear());

describe("sendToChatWithKeyboard", () => {
  it("sends HTML text to the founder's chat with the inline keyboard attached", async () => {
    await sendToChatWithKeyboard("<b>Standup</b>", [[{ text: "Plan next step · 1", callback_data: "goal:p:abc" }]]);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, text, options] = sendMessage.mock.calls[0]!;
    expect(chatId).toBe(process.env["TELEGRAM_CHAT_ID"]);
    expect(text).toBe("<b>Standup</b>");
    expect(options).toEqual({
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: "Plan next step · 1", callback_data: "goal:p:abc" }]] },
    });
  });

  it("sends no reply_markup at all when there are no buttons: an empty keyboard is not the same as none", async () => {
    await sendToChatWithKeyboard("hello", []);
    const [, , options] = sendMessage.mock.calls[0]!;
    expect(options).toEqual({ parse_mode: "HTML" });
    expect(options).not.toHaveProperty("reply_markup");
  });

  it("lets a delivery failure reach the caller, which decides what to do", async () => {
    sendMessage.mockRejectedValueOnce(new Error("Bad Gateway"));
    await expect(sendToChatWithKeyboard("hello", [])).rejects.toThrow("Bad Gateway");
  });
});
