/**
 * The goal commands through the REAL handler stack (`registerHandlers` in telegram.ts), driven with raw
 * Telegram updates, the way telegram-group-chat.test.ts drives the group rules. Only the kernel and the
 * storage are replaced: the kernel because a turn needs a model, storage because CI has no Postgres.
 *
 * What this pins that the handler tests cannot: that /goal and /goals are registered at all, that the
 * transport refuses a guest before any handler runs, that a goal button reaches its handler ahead of the
 * catch-all "Unknown action", that the HITL buttons still reach theirs, and that /resume tells the founder
 * which standups a halt swallowed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bot } from "grammy";
import type { UserFromGetMe } from "grammy/types";

const h = vi.hoisted(() => ({
  runKernelText: vi.fn(async (..._args: unknown[]) => undefined),
  resumeKernel: vi.fn(async (..._args: unknown[]) => undefined),
  repo: undefined as unknown,
  metrics: undefined as unknown,
}));

vi.mock("../../../src/gateway/kernel-run.js", () => ({
  runKernelText: (...args: unknown[]) => h.runKernelText(...args),
  resumeKernel: (...args: unknown[]) => h.resumeKernel(...args),
  withChatTurnLock: vi.fn(),
  restorePendingApproval: vi.fn(),
}));
vi.mock("../../../src/goals/pg-repo.js", () => ({ createPgGoalRepo: () => h.repo }));
vi.mock("../../../src/goals/metric-deps.js", () => ({ createRealMetricDeps: () => h.metrics }));

import { registerHandlers } from "../../../src/gateway/telegram.js";
import { OWNER_ONLY_COMMANDS, buildChatAccessConfig } from "../../../src/gateway/chat-access.js";
import { encodeGoalCallback } from "../../../src/goals/callbacks.js";
import { createFileSkipLedger } from "../../../src/goals/skipped.js";
import { TENANT } from "../../../src/core/config.js";
import { InMemoryGoalRepo } from "../../helpers/fake-goal-repo.js";
import { makeMetricDeps } from "../../helpers/goal-fixtures.js";

const BOT_ID = 999;
const BOT_USERNAME = "founderos_bot";
const OWNER = 4242; // in a private chat, chat id === user id
const GUEST = 7777;
const ALLOWED_GROUP = -100555;

interface SentCall {
  method: string;
  payload: Record<string, unknown>;
}
let sent: SentCall[] = [];
let updateId = 0;
let repo: InMemoryGoalRepo;
let haltDir: string;

function makeBot(): Bot {
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
    const result = method === "sendMessage" ? { message_id: 1, date: 0, chat: { id: (payload as { chat_id: number }).chat_id, type: "private" } } : true;
    return { ok: true, result } as never;
  });
  registerHandlers(bot, buildChatAccessConfig({ primaryChatId: String(OWNER), allowedChatIds: String(ALLOWED_GROUP) }));
  return bot;
}

const chat = (id: number): Record<string, unknown> => (id > 0 ? { id, type: "private", first_name: "Owner" } : { id, type: "supergroup", title: "Us" });

async function sendText(bot: Bot, o: { chatId: number; fromId: number; text: string }): Promise<void> {
  const end = o.text.indexOf(" ");
  await bot.handleUpdate({
    update_id: ++updateId,
    message: {
      message_id: updateId,
      date: 0,
      chat: chat(o.chatId),
      from: { id: o.fromId, is_bot: false, first_name: "U" },
      text: o.text,
      entities: [{ type: "bot_command", offset: 0, length: end === -1 ? o.text.length : end }],
    },
  } as never);
}

async function tap(bot: Bot, o: { chatId: number; fromId: number; data: string }): Promise<void> {
  await bot.handleUpdate({
    update_id: ++updateId,
    callback_query: {
      id: `cb-${updateId}`,
      chat_instance: "ci",
      data: o.data,
      from: { id: o.fromId, is_bot: false, first_name: "U" },
      message: { message_id: 5, date: 0, chat: chat(o.chatId), from: { id: BOT_ID, is_bot: true, first_name: "FounderOS" }, text: "Standup" },
    },
  } as never);
}

const texts = (): string[] => sent.filter((c) => c.method === "sendMessage").map((c) => String(c.payload["text"]));
const answers = (): Record<string, unknown>[] => sent.filter((c) => c.method === "answerCallbackQuery").map((c) => c.payload);

beforeEach(async () => {
  sent = [];
  h.runKernelText.mockClear();
  h.resumeKernel.mockClear();
  repo = new InMemoryGoalRepo();
  h.repo = repo;
  h.metrics = makeMetricDeps();
  haltDir = await mkdtemp(join(tmpdir(), "goal-wiring-"));
  process.env["HALT_FLAG_PATH"] = join(haltDir, "HALT");
});
afterEach(async () => {
  delete process.env["HALT_FLAG_PATH"];
  await rm(haltDir, { recursive: true, force: true });
});

describe("owner-only", () => {
  it("lists /goal and /goals among the commands a guest may not run", () => {
    expect(OWNER_ONLY_COMMANDS.has("goal")).toBe(true);
    expect(OWNER_ONLY_COMMANDS.has("goals")).toBe(true);
  });

  it("refuses a guest's /goal and /goals in an allow-listed group before any handler runs: nothing is created, nothing is read", async () => {
    const bot = makeBot();
    await sendText(bot, { chatId: ALLOWED_GROUP, fromId: GUEST, text: `/goal@${BOT_USERNAME} add x | metric=manual target=1` });
    await sendText(bot, { chatId: ALLOWED_GROUP, fromId: GUEST, text: `/goals@${BOT_USERNAME}` });
    expect(texts()).toEqual(["Only the owner can run /goal.", "Only the owner can run /goals."]);
    expect(repo.calls).toEqual([]); // no storage call at all, checked before this test itself reads the repo
    expect(await repo.listOpenGoals(TENANT)).toEqual([]);
  });

  it("lets the founder run them in his own chat", async () => {
    const bot = makeBot();
    await sendText(bot, { chatId: OWNER, fromId: OWNER, text: "/goal add Tashi applies | metric=applications_7d:wife-nl-finance target=5" });
    expect(texts()[0]).toContain("Goal 1 added: “Tashi applies”");
    expect((await repo.listOpenGoals(TENANT))[0]).toMatchObject({ title: "Tashi applies", metric_arg: "wife-nl-finance" });
    await sendText(bot, { chatId: OWNER, fromId: OWNER, text: "/goals" });
    expect(texts().at(-1)).toContain("1. Tashi applies: 0 of 5");
  });

  it("lets the founder run them from a group he is in, and only him", async () => {
    const bot = makeBot();
    await sendText(bot, { chatId: ALLOWED_GROUP, fromId: OWNER, text: `/goals@${BOT_USERNAME}` });
    expect(texts()[0]).toContain("No goals yet");
  });
});

describe("the buttons, through the real callback chain", () => {
  async function goalWithPlanButton(bot: Bot): Promise<string> {
    await sendText(bot, { chatId: OWNER, fromId: OWNER, text: "/goal add Tashi applies | metric=applications_7d:wife-nl-finance target=5 by=2026-10-31" });
    await sendText(bot, { chatId: OWNER, fromId: OWNER, text: "/goals" });
    const listing = sent.filter((c) => c.method === "sendMessage").at(-1)!;
    const keyboard = (listing.payload["reply_markup"] as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard;
    return keyboard[0]![0]!.callback_data;
  }

  it("runs a kernel turn when the founder taps Plan next step, and does not answer 'Unknown action'", async () => {
    const bot = makeBot();
    const data = await goalWithPlanButton(bot);
    sent = [];
    await tap(bot, { chatId: OWNER, fromId: OWNER, data });
    await vi.waitFor(() => expect(h.runKernelText).toHaveBeenCalledTimes(1));
    expect(String(h.runKernelText.mock.calls[0]![1])).toContain('Goal 1: "Tashi applies"');
    expect(answers().map((a) => String(a["text"]))).not.toContain("Unknown action");
  });

  it("refuses a guest's tap in an allow-listed group: no kernel run, told why", async () => {
    const bot = makeBot();
    const data = await goalWithPlanButton(bot);
    sent = [];
    await tap(bot, { chatId: ALLOWED_GROUP, fromId: GUEST, data });
    expect(h.runKernelText).not.toHaveBeenCalled();
    expect(String(answers()[0]!["text"])).toMatch(/only the owner/i);
  });

  it("still routes the HITL approve button to its own handler, and an unknown one to 'Unknown action'", async () => {
    const bot = makeBot();
    await tap(bot, { chatId: OWNER, fromId: OWNER, data: "approve:n1" });
    expect(h.resumeKernel).toHaveBeenCalledTimes(1);
    sent = [];
    await tap(bot, { chatId: OWNER, fromId: OWNER, data: "nonsense:1" });
    expect(String(answers()[0]!["text"])).toBe("Unknown action");
  });

  it("builds a Plan button whose payload fits Telegram's 64 bytes and decodes back to the goal", async () => {
    const bot = makeBot();
    const data = await goalWithPlanButton(bot);
    const [goal] = await repo.listOpenGoals(TENANT);
    expect(Buffer.byteLength(data, "utf8")).toBeLessThanOrEqual(64);
    expect(data).toBe(encodeGoalCallback({ kind: "plan", goalId: goal!.id }));
  });
});

describe("edge: /halt then /resume", () => {
  it("tells the founder, once, which standups the halt swallowed", async () => {
    const bot = makeBot();
    await sendText(bot, { chatId: OWNER, fromId: OWNER, text: "/halt" });
    const ledger = createFileSkipLedger();
    await ledger.record("2026-09-30");
    await ledger.record("2026-10-01");
    sent = [];
    await sendText(bot, { chatId: OWNER, fromId: OWNER, text: "/resume" });
    expect(texts()).toEqual(["▶️ Resumed — the kernel accepts turns again.", "standup skipped on 30 Sep, 1 Oct"]);
    sent = [];
    await sendText(bot, { chatId: OWNER, fromId: OWNER, text: "/resume" });
    expect(texts()).toEqual(["Not halted — nothing to resume."]);
  });

  it("adds nothing to /resume when no standup was skipped", async () => {
    const bot = makeBot();
    await sendText(bot, { chatId: OWNER, fromId: OWNER, text: "/halt" });
    sent = [];
    await sendText(bot, { chatId: OWNER, fromId: OWNER, text: "/resume" });
    expect(texts()).toEqual(["▶️ Resumed — the kernel accepts turns again."]);
  });
});
