/**
 * A goal said in plain words ("my goal this month is 20 applications") reaches /goal through the planner:
 * command-dispatch.ts replays it as a synthetic `/goal add … | target=20 by=…` update that carries the
 * founder's ORIGINAL message id. The metric is left out on purpose (planner.ts tells the model to), so the
 * reply is a metric picker sent as a reply to that original message.
 *
 * The bug: the picker re-reads the founder's /goal command from `reply_to_message.text`, which for a
 * plain-words goal is the sentence he typed, not a /goal command. Every tap answered "I can no longer read
 * your original /goal message. Send the command again.", and saying it again produced the same picker:
 * a loop in which no goal could ever be registered. A tap must finish the goal it was offered for.
 */

import { describe, it, expect, vi } from "vitest";
import type { Context } from "grammy";
import { handleGoal } from "../../../src/gateway/goal-commands.js";
import { handleGoalCallback } from "../../../src/gateway/goal-buttons.js";
import { buildChatAccessConfig } from "../../../src/gateway/chat-access.js";
import { OWNER, PRIMARY_CHAT, makeCtx, makeDeps, type GoalHarness, type Reply } from "../../helpers/goal-gateway.js";

const access = buildChatAccessConfig({ primaryChatId: String(OWNER), allowedChatIds: "" });

const FOUNDER_MESSAGE_ID = 42;
const FOUNDER_TEXT = "my goal this month is 20 applications";
/** What the planner hands /goal for that sentence (the shape planner.ts prescribes). */
const PLANNED_ARGS = "add Apply to 20 jobs | target=20 by=2026-10-31";

/** A sent message as Telegram would show it on a later callback: its id, its text, and what it replies to. */
interface SentMessage {
  readonly message_id: number;
  readonly reply: Reply;
}

/** A tap on a button of `picker`. The picker replies to the founder's plain-words message, as Telegram reports it. */
async function tapButton(h: GoalHarness, picker: SentMessage, buttonText: string) {
  const button = picker.reply.opts?.reply_markup?.inline_keyboard.flat().find((b) => b.text === buttonText);
  expect(button, `the picker offers a "${buttonText}" button`).toBeDefined();
  const replies: Reply[] = [];
  const sent: SentMessage[] = [];
  const answers: { text?: string; show_alert?: boolean }[] = [];
  const replyTo = picker.reply.opts?.reply_parameters?.message_id;
  const ctx = {
    chat: { id: PRIMARY_CHAT, type: "private" },
    from: { id: OWNER },
    callbackQuery: {
      data: button!.callback_data,
      message: {
        message_id: picker.message_id,
        text: picker.reply.text,
        ...(replyTo !== undefined ? { reply_to_message: { message_id: replyTo, text: replyTo === FOUNDER_MESSAGE_ID ? FOUNDER_TEXT : undefined } } : {}),
      },
    },
    reply: vi.fn(async (text: string, opts?: Reply["opts"]) => {
      const reply = { text, opts };
      replies.push(reply);
      const message_id = 2000 + replies.length;
      sent.push({ message_id, reply });
      return { message_id, text, chat: { id: PRIMARY_CHAT, type: "private" } };
    }),
    answerCallbackQuery: vi.fn(async (opts?: { text?: string; show_alert?: boolean }) => void answers.push(opts ?? {})),
    editMessageReplyMarkup: vi.fn(async () => undefined),
  };
  const handled = await handleGoalCallback(ctx as unknown as Context, access, h.deps);
  return { handled, replies, sent, answers };
}

/** The planner's synthetic `/goal add …` update, replayed with the founder's original message id. */
async function sayGoalInPlainWords(h: GoalHarness): Promise<SentMessage> {
  const c = makeCtx({ match: PLANNED_ARGS, messageId: FOUNDER_MESSAGE_ID });
  await handleGoal(c.ctx, h.deps);
  expect(c.replies).toHaveLength(1);
  const reply = c.replies[0]!;
  expect(reply.text).toContain("<b>metric</b>");
  expect(reply.opts?.reply_parameters?.message_id).toBe(FOUNDER_MESSAGE_ID);
  expect(await h.repo.listOpenGoals("t")).toEqual([]);
  return { message_id: 1001, reply };
}

describe("a goal said in plain words: the metric picker finishes it instead of looping", () => {
  it("tapping a metric that needs no argument registers the goal with the planned title, target and due date", async () => {
    const h = makeDeps();
    const picker = await sayGoalInPlainWords(h);

    const tap = await tapButton(h, picker, "manual");

    expect(tap.handled).toBe(true);
    expect(tap.answers.filter((a) => a.show_alert === true), JSON.stringify(tap.answers)).toEqual([]);
    expect(tap.answers.map((a) => a.text ?? "").join(" ")).not.toMatch(/can no longer read|send the command again/i);
    const open = await h.repo.listOpenGoals("t");
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ title: "Apply to 20 jobs", metric_key: "manual", metric_arg: null, target: 20, due_on: "2026-10-31" });
    expect(tap.replies.map((r) => r.text).join("\n")).toContain("Goal 1 added: “Apply to 20 jobs”");
  });

  it("a metric that needs an argument asks for it, and the second tap registers the goal (no error loop)", async () => {
    const h = makeDeps();
    const picker = await sayGoalInPlainWords(h);

    const first = await tapButton(h, picker, "applications_7d");
    expect(first.answers.filter((a) => a.show_alert === true), JSON.stringify(first.answers)).toEqual([]);
    expect(await h.repo.listOpenGoals("t")).toEqual([]);
    const argPicker = first.sent.find((m) => (m.reply.opts?.reply_markup?.inline_keyboard.flat() ?? []).some((b) => b.text === "wife-nl-finance"));
    expect(argPicker, "the profile picker is offered next").toBeDefined();

    const second = await tapButton(h, argPicker!, "wife-nl-finance");
    expect(second.answers.filter((a) => a.show_alert === true), JSON.stringify(second.answers)).toEqual([]);
    const open = await h.repo.listOpenGoals("t");
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ title: "Apply to 20 jobs", metric_key: "applications_7d", metric_arg: "wife-nl-finance", target: 20, due_on: "2026-10-31" });
  });
});
