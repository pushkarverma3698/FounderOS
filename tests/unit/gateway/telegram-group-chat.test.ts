/**
 * The bot in a group chat — the founder's report of 2026-09-28.
 *
 * WHAT HAPPENED. "When I add the FounderOS bot to another group with someone
 * else it doesn't work and doesn't reply." The only authorization rule was
 * `ctx.chat.id === TELEGRAM_CHAT_ID`. A group has its own (negative) chat id,
 * so every update from every group — the founder's own messages included — hit
 * "Ignored update from unauthorized chat" and was dropped with no reply.
 *
 * These tests drive the REAL handler stack (`registerHandlers`) with raw
 * Telegram updates and record what the bot sends back, so they fail on the
 * transport behaviour the founder saw, not on a helper's return value. Only the
 * kernel and the halt handler are replaced — the first because a turn needs a
 * model, the second so "a guest cannot halt the system" is observable.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Bot } from "grammy";
import type { UserFromGetMe } from "grammy/types";

const runKernelText = vi.fn(async (..._args: unknown[]) => undefined);
const resumeKernel = vi.fn(async (..._args: unknown[]) => undefined);

vi.mock("../../../src/gateway/kernel-run.js", () => ({
  runKernelText: (...args: unknown[]) => runKernelText(...args),
  resumeKernel: (...args: unknown[]) => resumeKernel(...args),
  withChatTurnLock: vi.fn(),
  restorePendingApproval: vi.fn(),
}));

const handleHalt = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock("../../../src/gateway/commands.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/gateway/commands.js")>()),
  handleHalt: (...args: unknown[]) => handleHalt(...args),
}));

import { registerHandlers } from "../../../src/gateway/telegram.js";
import { buildChatAccessConfig } from "../../../src/gateway/chat-access.js";

const BOT_ID = 999;
const BOT_USERNAME = "founderos_bot";
const OWNER = 4242; // the founder — in a private chat, chat id === user id
const GUEST = 7777; // "someone else" in the group
const ALLOWED_GROUP = -100555;
const OTHER_GROUP = -100666;

interface SentCall {
  method: string;
  payload: Record<string, unknown>;
}

let sent: SentCall[] = [];
let updateId = 0;

function makeBot(allowed = String(ALLOWED_GROUP), primaryChatId = String(OWNER)): Bot {
  const bot = new Bot("1:test", {
    botInfo: {
      id: BOT_ID,
      is_bot: true,
      first_name: "FounderOS",
      username: BOT_USERNAME,
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
    } as UserFromGetMe,
  });
  bot.api.config.use(async (_prev, method, payload) => {
    sent.push({ method, payload: payload as Record<string, unknown> });
    const result =
      method === "sendMessage"
        ? { message_id: 1, date: 0, chat: { id: (payload as { chat_id: number }).chat_id, type: "private" } }
        : true;
    return { ok: true, result } as never;
  });
  registerHandlers(
    bot,
    buildChatAccessConfig({ primaryChatId, allowedChatIds: allowed }),
  );
  return bot;
}

function chat(id: number): Record<string, unknown> {
  return id > 0
    ? { id, type: "private", first_name: "Owner" }
    : { id, type: "supergroup", title: "Us" };
}

async function sendText(
  bot: Bot,
  opts: { chatId: number; fromId: number; text: string; replyToBot?: boolean },
): Promise<void> {
  const mentionAt = opts.text.indexOf(`@${BOT_USERNAME}`);
  const entities: Record<string, unknown>[] = [];
  if (opts.text.startsWith("/")) {
    const end = opts.text.indexOf(" ");
    entities.push({ type: "bot_command", offset: 0, length: end === -1 ? opts.text.length : end });
  } else if (mentionAt >= 0) {
    entities.push({ type: "mention", offset: mentionAt, length: BOT_USERNAME.length + 1 });
  }
  await bot.handleUpdate({
    update_id: ++updateId,
    message: {
      message_id: updateId,
      date: 0,
      chat: chat(opts.chatId),
      from: { id: opts.fromId, is_bot: false, first_name: "U" },
      text: opts.text,
      ...(entities.length > 0 ? { entities } : {}),
      ...(opts.replyToBot
        ? {
            reply_to_message: {
              message_id: 1,
              date: 0,
              chat: chat(opts.chatId),
              from: { id: BOT_ID, is_bot: true, first_name: "FounderOS", username: BOT_USERNAME },
              text: "Here are today's roles",
            },
          }
        : {}),
    },
  } as never);
}

async function tapButton(bot: Bot, opts: { chatId: number; fromId: number; data: string }): Promise<void> {
  await bot.handleUpdate({
    update_id: ++updateId,
    callback_query: {
      id: `cb-${updateId}`,
      chat_instance: "ci",
      data: opts.data,
      from: { id: opts.fromId, is_bot: false, first_name: "U" },
      message: {
        message_id: 5,
        date: 0,
        chat: chat(opts.chatId),
        from: { id: BOT_ID, is_bot: true, first_name: "FounderOS" },
        text: "Approve?",
      },
    },
  } as never);
}

const texts = (): string[] =>
  sent.filter((c) => c.method === "sendMessage").map((c) => String(c.payload["text"]));

beforeEach(() => {
  sent = [];
  runKernelText.mockClear();
  resumeKernel.mockClear();
  handleHalt.mockClear();
});

describe("the founder's own chat — unchanged", () => {
  it("runs every plain message through the kernel", async () => {
    const bot = makeBot();
    await sendText(bot, { chatId: OWNER, fromId: OWNER, text: "what jobs today" });
    expect(runKernelText).toHaveBeenCalledTimes(1);
    expect(runKernelText.mock.calls[0]![1]).toBe("what jobs today");
  });

  it("keeps answering every message when the primary chat is itself a group", async () => {
    // .env.example documents TELEGRAM_CHAT_ID as possibly a group. That chat
    // always ran every message through the kernel; the "only when addressed"
    // rule is for OTHER groups and must not change it.
    const bot = makeBot(String(ALLOWED_GROUP), String(OTHER_GROUP));
    await sendText(bot, { chatId: OTHER_GROUP, fromId: GUEST, text: "what jobs today" });
    expect(runKernelText).toHaveBeenCalledTimes(1);
    expect(runKernelText.mock.calls[0]![1]).toBe("what jobs today");
  });

  it("still lets the primary chat approve a HITL card", async () => {
    const bot = makeBot();
    await tapButton(bot, { chatId: OWNER, fromId: OWNER, data: "approve:n1" });
    expect(resumeKernel).toHaveBeenCalledTimes(1);
  });
});

describe("a group the founder allow-listed", () => {
  it("answers a guest who mentions the bot, with the mention stripped", async () => {
    const bot = makeBot();
    await sendText(bot, { chatId: ALLOWED_GROUP, fromId: GUEST, text: `@${BOT_USERNAME} show tashi's jobs` });
    expect(runKernelText).toHaveBeenCalledTimes(1);
    expect(runKernelText.mock.calls[0]![1]).toBe("show tashi's jobs");
  });

  it("answers a reply to one of the bot's own messages", async () => {
    const bot = makeBot();
    await sendText(bot, { chatId: ALLOWED_GROUP, fromId: GUEST, text: "and the second one?", replyToBot: true });
    expect(runKernelText).toHaveBeenCalledTimes(1);
  });

  it("stays out of conversation that is not addressed to it", async () => {
    // Two people talking to each other must not start a paid model turn per
    // message, and must not get a bot reply to every line.
    const bot = makeBot();
    await sendText(bot, { chatId: ALLOWED_GROUP, fromId: GUEST, text: "did you see the KLM role?" });
    expect(runKernelText).not.toHaveBeenCalled();
    expect(texts()).toEqual([]);
  });

  it("ignores a command addressed to a different bot, and answers one addressed to this bot", async () => {
    const bot = makeBot();
    await sendText(bot, { chatId: ALLOWED_GROUP, fromId: GUEST, text: "/nosuchcmd@some_other_bot" });
    expect(texts()).toEqual([]);
    await sendText(bot, { chatId: ALLOWED_GROUP, fromId: GUEST, text: `/nosuchcmd@${BOT_USERNAME}` });
    expect(texts()).toHaveLength(1);
  });

  it("refuses system-level commands from a guest — /halt stays the founder's", async () => {
    const bot = makeBot();
    await sendText(bot, { chatId: ALLOWED_GROUP, fromId: GUEST, text: `/halt@${BOT_USERNAME}` });
    expect(handleHalt).not.toHaveBeenCalled();
    expect(texts().join("\n")).toMatch(/only the owner/i);
    await sendText(bot, { chatId: ALLOWED_GROUP, fromId: OWNER, text: `/halt@${BOT_USERNAME}` });
    expect(handleHalt).toHaveBeenCalledTimes(1);
  });

  it("lets only the founder approve a HITL card", async () => {
    const bot = makeBot();
    await tapButton(bot, { chatId: ALLOWED_GROUP, fromId: GUEST, data: "approve:n1" });
    expect(resumeKernel).not.toHaveBeenCalled();
    const refusal = sent.find((c) => c.method === "answerCallbackQuery");
    expect(String(refusal?.payload["text"])).toMatch(/only the owner/i);

    await tapButton(bot, { chatId: ALLOWED_GROUP, fromId: OWNER, data: "approve:n1" });
    expect(resumeKernel).toHaveBeenCalledTimes(1);
  });

  it("lets only the founder tap Retry — it re-runs his turn, owner-only commands included", async () => {
    // A failed /task (owner-only) gets a Retry button like any other turn. A
    // guest tapping it would run the founder's /task text as the guest.
    const bot = makeBot();
    await tapButton(bot, { chatId: ALLOWED_GROUP, fromId: GUEST, data: "retry:3f2a9c1e" });
    expect(runKernelText).not.toHaveBeenCalled();
    const refusal = sent.find((c) => c.method === "answerCallbackQuery");
    expect(String(refusal?.payload["text"])).toMatch(/only the owner/i);
  });
});

describe("a group nobody allow-listed", () => {
  it("answers the founder, and tells him how to open it to the others", async () => {
    const bot = makeBot();
    await sendText(bot, { chatId: OTHER_GROUP, fromId: OWNER, text: `@${BOT_USERNAME} hi` });
    expect(runKernelText).toHaveBeenCalledTimes(1);
    const hint = texts().join("\n");
    expect(hint).toContain(`TELEGRAM_ALLOWED_CHAT_IDS=${OTHER_GROUP}`);

    // Once per chat, not on every message.
    sent = [];
    await sendText(bot, { chatId: OTHER_GROUP, fromId: OWNER, text: `@${BOT_USERNAME} again` });
    expect(texts().join("\n")).not.toContain("TELEGRAM_ALLOWED_CHAT_IDS");
  });

  it("stays silent to a stranger — a reply would confirm the bot is listening", async () => {
    const bot = makeBot();
    await sendText(bot, { chatId: OTHER_GROUP, fromId: GUEST, text: `@${BOT_USERNAME} read me his email` });
    expect(runKernelText).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it("stays silent to a stranger's private message", async () => {
    const bot = makeBot();
    await sendText(bot, { chatId: GUEST, fromId: GUEST, text: "hello" });
    expect(runKernelText).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });
});
