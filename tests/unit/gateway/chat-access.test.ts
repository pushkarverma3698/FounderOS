/**
 * Who the bot answers, as pure rules — see telegram-group-chat.test.ts for the
 * transport-level behaviour these decide.
 */

import { describe, it, expect } from "vitest";
import {
  buildChatAccessConfig,
  classifyChatAccess,
  commandName,
  isAddressedToBot,
  mayActAsOwner,
  stripBotMention,
} from "../../../src/gateway/chat-access.js";

const BOT = { id: 999, username: "founderos_bot" };

describe("buildChatAccessConfig", () => {
  it("derives the owner from a private primary chat — there chat id IS the user id", () => {
    expect(buildChatAccessConfig({ primaryChatId: "4242" }).ownerUserId).toBe("4242");
  });

  it("derives no owner from a group primary chat, and an explicit owner always wins", () => {
    expect(buildChatAccessConfig({ primaryChatId: "-1001234" }).ownerUserId).toBeNull();
    expect(buildChatAccessConfig({ primaryChatId: "-1001234", ownerUserId: "4242" }).ownerUserId).toBe("4242");
  });

  it("parses the allow-list leniently and drops anything that is not a chat id", () => {
    const cfg = buildChatAccessConfig({ primaryChatId: "1", allowedChatIds: " -100555, 7777 ,, abc, -12x" });
    expect([...cfg.allowedChatIds].sort()).toEqual(["-100555", "7777"]);
  });
});

describe("classifyChatAccess", () => {
  const cfg = buildChatAccessConfig({ primaryChatId: "4242", allowedChatIds: "-100555" });

  it("names each case", () => {
    expect(classifyChatAccess({ chatId: 4242, chatType: "private", fromId: 4242 }, cfg)).toBe("primary");
    expect(classifyChatAccess({ chatId: -100555, chatType: "supergroup", fromId: 7777 }, cfg)).toBe("allowed");
    expect(classifyChatAccess({ chatId: -100666, chatType: "group", fromId: 4242 }, cfg)).toBe("owner-in-group");
    expect(classifyChatAccess({ chatId: -100666, chatType: "group", fromId: 7777 }, cfg)).toBe("denied");
    expect(classifyChatAccess({ chatId: 7777, chatType: "private", fromId: 7777 }, cfg)).toBe("denied");
    expect(classifyChatAccess({}, cfg)).toBe("denied");
  });

  it("never grants owner-in-group when no owner is known", () => {
    const groupPrimary = buildChatAccessConfig({ primaryChatId: "-1001234" });
    expect(classifyChatAccess({ chatId: -100666, chatType: "group", fromId: 4242 }, groupPrimary)).toBe("denied");
  });
});

describe("mayActAsOwner", () => {
  const cfg = buildChatAccessConfig({ primaryChatId: "4242", allowedChatIds: "-100555" });
  it("is unconditional in the primary chat and owner-only elsewhere", () => {
    expect(mayActAsOwner("primary", 1, cfg)).toBe(true);
    expect(mayActAsOwner("allowed", 7777, cfg)).toBe(false);
    expect(mayActAsOwner("allowed", 4242, cfg)).toBe(true);
    expect(mayActAsOwner("owner-in-group", 4242, cfg)).toBe(true);
  });
});

describe("isAddressedToBot", () => {
  it("treats every private message as addressed", () => {
    expect(isAddressedToBot({ chatType: "private", text: "hi" }, BOT)).toBe(true);
  });

  it("recognises a mention by username, case-insensitively", () => {
    const text = "hey @FounderOS_Bot jobs";
    expect(
      isAddressedToBot({ chatType: "group", text, entities: [{ type: "mention", offset: 4, length: 14 }] }, BOT),
    ).toBe(true);
  });

  it("recognises a text_mention by id, and a reply to the bot", () => {
    expect(
      isAddressedToBot(
        { chatType: "group", text: "FounderOS jobs", entities: [{ type: "text_mention", offset: 0, length: 9, user: { id: 999 } }] },
        BOT,
      ),
    ).toBe(true);
    expect(isAddressedToBot({ chatType: "group", text: "and?", replyToFromId: 999 }, BOT)).toBe(true);
  });

  it("does not treat a mention of someone else, or plain chatter, as addressed", () => {
    expect(
      isAddressedToBot({ chatType: "group", text: "@tashi look", entities: [{ type: "mention", offset: 0, length: 6 }] }, BOT),
    ).toBe(false);
    expect(isAddressedToBot({ chatType: "supergroup", text: "lunch?" }, BOT)).toBe(false);
  });

  it("accepts a bare command or one for this bot, never one for another bot", () => {
    expect(isAddressedToBot({ chatType: "group", text: "/jobs wife" }, BOT)).toBe(true);
    expect(isAddressedToBot({ chatType: "group", text: "/jobs@founderos_bot wife" }, BOT)).toBe(true);
    expect(isAddressedToBot({ chatType: "group", text: "/jobs@other_bot" }, BOT)).toBe(false);
  });

  it("reads a media caption the same way as text", () => {
    expect(
      isAddressedToBot(
        { chatType: "group", caption: "@founderos_bot read this", captionEntities: [{ type: "mention", offset: 0, length: 14 }] },
        BOT,
      ),
    ).toBe(true);
  });
});

describe("commandName", () => {
  it("returns the bare name for this bot's commands and null otherwise", () => {
    expect(commandName("/halt", "founderos_bot")).toBe("halt");
    expect(commandName("/Halt@FounderOS_bot now", "founderos_bot")).toBe("halt");
    expect(commandName("/halt@other_bot", "founderos_bot")).toBeNull();
    expect(commandName("halt", "founderos_bot")).toBeNull();
  });
});

describe("stripBotMention", () => {
  it("removes the mention wherever it sits and tidies the spacing", () => {
    expect(stripBotMention("@founderos_bot show jobs", "founderos_bot")).toBe("show jobs");
    expect(stripBotMention("show @FounderOS_Bot jobs", "founderos_bot")).toBe("show jobs");
    expect(stripBotMention("mail @founderos_botanist", "founderos_bot")).toBe("mail @founderos_botanist");
  });
});
