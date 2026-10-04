import { describe, expect, it } from "vitest";
import { injectSenderProfile, parseSenderProfiles } from "../../../src/gateway/jobhunt-sender-profile.js";

describe("parseSenderProfiles", () => {
  it("reads id=token pairs and drops junk", () => {
    const m = parseSenderProfiles("111=wife, x=bad,222=pushkar,333=");
    expect([...m]).toEqual([[111, "wife"], [222, "pushkar"]]);
  });
  it("is empty for undefined", () => expect(parseSenderProfiles(undefined).size).toBe(0));
});

describe("injectSenderProfile", () => {
  it("adds the sender's profile to a bare job command", () => {
    expect(injectSenderProfile("/today", "wife")).toBe("/today wife");
  });
  it("keeps arguments and the @bot suffix", () => {
    expect(injectSenderProfile("/draft@FounderBot 3", "wife")).toBe("/draft@FounderBot wife 3");
  });
  it("leaves an explicit profile alone", () => {
    expect(injectSenderProfile("/today wife", "pushkar")).toBe("/today wife");
  });
  it("leaves non-job commands and plain text alone", () => {
    expect(injectSenderProfile("/status", "wife")).toBe("/status");
    expect(injectSenderProfile("hello", "wife")).toBe("hello");
  });
});

describe("through grammy's command matcher", () => {
  it("a rewritten message reaches the handler with the profile as ctx.match", async () => {
    const { Bot } = await import("grammy");
    const bot = new Bot("1:test", { botInfo: { id: 1, is_bot: true, first_name: "b", username: "b", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false, can_manage_bots: false } as never });
    const map = parseSenderProfiles("111=wife");
    let seen = "";
    bot.use(async (ctx, next) => {
      const p = ctx.from ? map.get(ctx.from.id) : undefined;
      if (ctx.message?.text && p) ctx.message.text = injectSenderProfile(ctx.message.text, p);
      await next();
    });
    bot.command("draft", (ctx) => { seen = String(ctx.match); });
    await bot.handleUpdate({ update_id: 1, message: { message_id: 1, date: 0, chat: { id: 5, type: "private" }, from: { id: 111, is_bot: false, first_name: "T" }, text: "/draft 3", entities: [{ type: "bot_command", offset: 0, length: 6 }] } } as never);
    expect(seen).toBe("wife 3");
  });
});
