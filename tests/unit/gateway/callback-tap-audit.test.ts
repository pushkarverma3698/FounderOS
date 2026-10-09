/**
 * Live QA 2026-10-09: a spec card was approved at 09:48:42 and nothing recorded WHO tapped it. Every button tap now
 * leaves a durable audit row naming the Telegram user, the chat, the message and the button, for refused taps too.
 * Drives the real handler stack (`registerHandlers`) with raw callback updates, like telegram-group-chat.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Bot } from "grammy";
import type { UserFromGetMe } from "grammy/types";

const resumeKernel = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock("../../../src/gateway/kernel-run.js", () => ({
  runKernelText: vi.fn(async () => undefined),
  resumeKernel: (...args: unknown[]) => resumeKernel(...args),
  withChatTurnLock: vi.fn(),
  restorePendingApproval: vi.fn(),
}));

const writeAuditEntry = vi.hoisted(() => vi.fn(async (_row: unknown) => ({ written: true })));
vi.mock("../../../src/db/queries.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  writeAuditEntry,
}));

import { registerHandlers } from "../../../src/gateway/telegram.js";
import { buildChatAccessConfig } from "../../../src/gateway/chat-access.js";

const OWNER = 4242;
const GUEST = 7777;
const GROUP = -100555;

let updateId = 0;

function makeBot(): Bot {
  const bot = new Bot("1:test", {
    botInfo: {
      id: 999,
      is_bot: true,
      first_name: "FounderOS",
      username: "founderos_bot",
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
    } as UserFromGetMe,
  });
  bot.api.config.use(async () => ({ ok: true, result: true }) as never);
  registerHandlers(bot, buildChatAccessConfig({ primaryChatId: String(OWNER), allowedChatIds: String(GROUP), answerAllChatIds: "" }));
  return bot;
}

async function tap(bot: Bot, o: { chatId: number; fromId: number; data: string; username?: string }): Promise<void> {
  await bot.handleUpdate({
    update_id: ++updateId,
    callback_query: {
      id: `cb-${updateId}`,
      chat_instance: "ci",
      data: o.data,
      from: { id: o.fromId, is_bot: false, first_name: "U", ...(o.username ? { username: o.username } : {}) },
      message: {
        message_id: 5,
        date: 0,
        chat: o.chatId > 0 ? { id: o.chatId, type: "private", first_name: "O" } : { id: o.chatId, type: "supergroup", title: "Us" },
        from: { id: 999, is_bot: true, first_name: "FounderOS" },
        text: "Approve?",
      },
    },
  } as never);
}

beforeEach(() => {
  writeAuditEntry.mockClear();
  resumeKernel.mockClear();
});

describe("callback tap audit", () => {
  it("records who tapped an approval button, in which chat, on which message, and what it said", async () => {
    await tap(makeBot(), { chatId: OWNER, fromId: OWNER, data: "approve:88ebb08c", username: "pushkar" });
    expect(resumeKernel).toHaveBeenCalledTimes(1);
    expect(writeAuditEntry).toHaveBeenCalledTimes(1);
    const row = writeAuditEntry.mock.calls[0]![0] as { action: string; idempotency_key: string; payload: Record<string, unknown> };
    expect(row.action).toBe("callback_tap");
    expect(row.idempotency_key).toContain("cb-");
    expect(row.payload).toMatchObject({
      from_id: OWNER,
      from_username: "pushkar",
      chat_id: OWNER,
      message_id: 5,
      data: "approve:88ebb08c",
      outcome: "allowed",
    });
  });

  it("records a refused tap by a guest too, with their id", async () => {
    await tap(makeBot(), { chatId: GROUP, fromId: GUEST, data: "approve:n1" });
    expect(resumeKernel).not.toHaveBeenCalled();
    expect(writeAuditEntry).toHaveBeenCalledTimes(1);
    expect((writeAuditEntry.mock.calls[0]![0] as { payload: Record<string, unknown> }).payload).toMatchObject({
      from_id: GUEST,
      chat_id: GROUP,
      outcome: "refused",
    });
  });

  it("a failing audit write never costs the founder his tap", async () => {
    writeAuditEntry.mockRejectedValueOnce(new Error("db down"));
    await tap(makeBot(), { chatId: OWNER, fromId: OWNER, data: "approve:n2" });
    expect(resumeKernel).toHaveBeenCalledTimes(1);
  });
});
