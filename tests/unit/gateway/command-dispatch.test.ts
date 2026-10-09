/**
 * Plain words → the real slash-command handler.
 * The dispatcher re-enters the bot with the founder's own identity, so these tests drive a
 * real grammy Bot (no network) and assert what the registered handler actually receives.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { Bot, type Context } from "grammy";
import { COMMAND_MENU } from "../../../src/gateway/command-menu.js";
import {
  NEVER_FROM_PLAIN_WORDS,
  READ_ONLY_COMMANDS,
  needsConfirmation,
  plannableCommands,
} from "../../../src/gateway/command-catalog.js";
import {
  handleCommandCallback,
  registerCommandDispatch,
  runPlannedCommand,
  syntheticCommandUpdate,
} from "../../../src/gateway/command-dispatch.js";

const chat = { id: 42, type: "private" as const, first_name: "F" };
const from = { id: 7, is_bot: false, first_name: "F" };

function makeBot() {
  const bot = new Bot("123:fake", {
    botInfo: { id: 123, is_bot: true, first_name: "b", username: "founderos_bot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false,
      can_manage_bots: false, allows_users_to_create_topics: false },
  });
  const seen: Array<{ cmd: string; match: string; fromId?: number; chatId?: number }> = [];
  for (const name of ["where", "task", "focus"]) {
    bot.command(name, (ctx) => {
      seen.push({ cmd: name, match: String(ctx.match), fromId: ctx.from?.id, chatId: ctx.chat?.id });
    });
  }
  registerCommandDispatch(bot);
  return { bot, seen };
}

function fakeCtx(replies: Array<{ text: string; opts: any }>): Context {
  return {
    chat, from, message: { message_id: 9, chat, from },
    reply: vi.fn(async (text: string, opts: any) => { replies.push({ text, opts }); }),
  } as unknown as Context;
}

function tapCtx(data: string, answers: string[], edits: unknown[], tapper: { id: number } = from): Context {
  return {
    from: tapper,
    callbackQuery: { data },
    answerCallbackQuery: vi.fn(async (o: { text: string }) => { answers.push(o.text); }),
    editMessageReplyMarkup: vi.fn(async (o: unknown) => { edits.push(o); }),
  } as unknown as Context;
}

describe("command catalog", () => {
  it("is derived from the menu: no hidden aliases, no /reset or /start", () => {
    const names = plannableCommands().map((c) => c.name);
    expect(names).not.toContain("reset");
    expect(names).not.toContain("start");
    // /remind's handler is itself a planner turn: routing plain words to it loops (card -> Run -> same card, no row).
    expect(names).not.toContain("remind");
    expect(names.some((n) => n.startsWith("wife_"))).toBe(false);
    const menu = new Set(COMMAND_MENU.map((e) => e.command));
    for (const n of names) expect(menu.has(n)).toBe(true);
    for (const n of NEVER_FROM_PLAIN_WORDS) expect(menu.has(n)).toBe(true);
  });

  it("every read-only name is a real menu command (a typo here would silently demand a tap)", () => {
    const menu = new Set(COMMAND_MENU.map((e) => e.command));
    for (const n of READ_ONLY_COMMANDS) expect(menu.has(n), n).toBe(true);
  });

  it("asks for a tap unless the command only reads", () => {
    expect(needsConfirmation("where", "oplify")).toBe(false);
    expect(needsConfirmation("jobs", "tashi")).toBe(false);
    expect(needsConfirmation("task", "fix login")).toBe(true);
    expect(needsConfirmation("applied", "3")).toBe(true);
    expect(needsConfirmation("halt", "")).toBe(true);
    expect(needsConfirmation("some_new_command", "")).toBe(true);
    expect(needsConfirmation("focus", "")).toBe(false);
    expect(needsConfirmation("focus", "close the pilot")).toBe(true);
  });

  it("marks mutating commands for the planner from the same table", () => {
    const by = Object.fromEntries(plannableCommands().map((c) => [c.name, c.mutating]));
    expect(by["where"]).toBe(false);
    expect(by["task"]).toBe(true);
  });
});

describe("syntheticCommandUpdate", () => {
  it("looks like the founder typed it: text, command entity, his chat and id", () => {
    const u = syntheticCommandUpdate({ messageId: 9, chat, from }, { name: "where", args: "oplify" });
    expect(u.message?.text).toBe("/where oplify");
    expect(u.message?.entities).toEqual([{ type: "bot_command", offset: 0, length: 6 }]);
    expect(u.message?.from?.id).toBe(7);
    expect(u.message?.chat.id).toBe(42);
  });
});

describe("runPlannedCommand", () => {
  let h: ReturnType<typeof makeBot>;
  beforeEach(() => { h = makeBot(); });

  it("runs a read-only command at once through the real handler, args intact", async () => {
    const replies: any[] = [];
    await runPlannedCommand(fakeCtx(replies), { name: "where", args: "oplify" });
    expect(h.seen).toEqual([{ cmd: "where", match: "oplify", fromId: 7, chatId: 42 }]);
    expect(replies).toHaveLength(0);
  });

  it("holds a mutating command behind a card; nothing runs until Run is tapped", async () => {
    const replies: any[] = [];
    await runPlannedCommand(fakeCtx(replies), { name: "task", args: "fix the <login> bug" });
    expect(h.seen).toHaveLength(0);
    expect(replies[0].text).toContain("/task fix the &lt;login&gt; bug"); // HTML-escaped
    const buttons = replies[0].opts.reply_markup.inline_keyboard.flat();
    const run = buttons.find((b: any) => b.text.includes("Run")).callback_data as string;
    expect(Buffer.byteLength(run)).toBeLessThanOrEqual(64);

    const answers: string[] = []; const edits: unknown[] = [];
    expect(await handleCommandCallback(tapCtx(run, answers, edits))).toBe(true);
    expect(h.seen).toEqual([{ cmd: "task", match: "fix the <login> bug", fromId: 7, chatId: 42 }]);
    expect(edits).toHaveLength(1);

    // A second tap on the same card finds nothing: one tap, one run.
    const again: string[] = [];
    await handleCommandCallback(tapCtx(run, again, []));
    expect(again).toEqual(["Expired — say it again."]);
    expect(h.seen).toHaveLength(1);
  });

  it("a stranger's tap in the group runs nothing and leaves the owner's card usable", async () => {
    const replies: any[] = [];
    await runPlannedCommand(fakeCtx(replies), { name: "task", args: "fix it" });
    const run = replies[0].opts.reply_markup.inline_keyboard.flat().find((b: any) => b.text.includes("Run")).callback_data as string;

    const answers: string[] = []; const edits: unknown[] = [];
    await handleCommandCallback(tapCtx(run, answers, edits, { id: 999 }));
    expect(answers).toEqual(["Only the person who asked can do that."]);
    expect(edits).toHaveLength(0); // the buttons stay
    expect(h.seen).toHaveLength(0);

    // The owner's own tap still works afterwards.
    await handleCommandCallback(tapCtx(run, [], []));
    expect(h.seen).toEqual([{ cmd: "task", match: "fix it", fromId: 7, chatId: 42 }]);
  });

  it("Cancel runs nothing", async () => {
    const replies: any[] = [];
    await runPlannedCommand(fakeCtx(replies), { name: "task", args: "x" });
    const cancel = replies[0].opts.reply_markup.inline_keyboard.flat().find((b: any) => b.text.includes("Cancel")).callback_data;
    const answers: string[] = [];
    await handleCommandCallback(tapCtx(cancel, answers, []));
    expect(answers).toEqual(["Cancelled"]);
    expect(h.seen).toHaveLength(0);
  });

  it("ignores callback payloads that are not its own", async () => {
    expect(await handleCommandCallback(tapCtx("approve:abc", [], []))).toBe(false);
  });
});
