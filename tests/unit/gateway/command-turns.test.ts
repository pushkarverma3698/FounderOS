import { describe, it, expect, vi } from "vitest";
import type { Context } from "grammy";
import type { Update } from "grammy/types";
import {
  typedCommandTurn,
  commandTurnRecorder,
  markSyntheticUpdate,
  isSyntheticUpdate,
  COMMAND_TURN_ARGS_MAX_CHARS,
} from "../../../src/gateway/command-turns.js";
import { syntheticCommandUpdate } from "../../../src/gateway/command-dispatch.js";
import type { StoredTurn } from "../../../src/db/conversation-turns.js";

const BOT = "FounderOSBot";

function typed(text: string, updateId = 41, dateSeconds = 1_759_700_000) {
  return typedCommandTurn({ updateId, text, dateSeconds, botUsername: BOT });
}

describe("typedCommandTurn", () => {
  it("files a typed read-only command as a done turn", () => {
    expect(typed("/tasks")).toEqual({
      turn_id: "cmd-41",
      at: new Date(1_759_700_000 * 1000).toISOString(),
      user_input: "/tasks",
      goal: "/tasks",
      outcome: "done",
      reply: "Ran /tasks",
    });
  });

  it("keeps the arguments, trimmed", () => {
    const turn = typed("/where   founderos  ");
    expect(turn?.user_input).toBe("/where founderos");
    expect(turn?.reply).toBe("Ran /where founderos");
  });

  it("caps very long arguments", () => {
    const turn = typed("/focus " + "x".repeat(COMMAND_TURN_ARGS_MAX_CHARS * 3));
    expect(turn?.user_input.length).toBe("/focus ".length + COMMAND_TURN_ARGS_MAX_CHARS);
  });

  it("accepts the bot-addressed form and drops the suffix", () => {
    expect(typed("/status@FounderOSBot")?.user_input).toBe("/status");
  });

  it("skips a command addressed to another bot", () => {
    expect(typed("/status@SomeoneElseBot")).toBeNull();
  });

  it("skips plain text", () => {
    expect(typed("what is running")).toBeNull();
  });

  it("skips a name the bot does not answer to", () => {
    expect(typed("/definitelynotacommand")).toBeNull();
  });

  it("never stores /login or /connect arguments", () => {
    expect(typed("/login claude sk-secret")).toBeNull();
    expect(typed("/connect some-server")).toBeNull();
  });

  it("leaves commands that start a kernel turn to the kernel", () => {
    for (const text of ["/task fix the bug", "/ask what next", "/draft 3", "/remind call at 3pm", "/claude x", "/agy x"]) {
      expect(typed(text), text).toBeNull();
    }
  });

  it("gives the same turn_id for the same update, so a redelivery is one row", () => {
    expect(typed("/tasks", 7)?.turn_id).toBe(typed("/tasks", 7)?.turn_id);
    expect(typed("/tasks", 7)?.turn_id).not.toBe(typed("/tasks", 8)?.turn_id);
  });
});

describe("synthetic updates", () => {
  it("marks the update command-dispatch replays, and only that one", () => {
    const real = { update_id: 1 } as Update;
    expect(isSyntheticUpdate(real)).toBe(false);
    expect(isSyntheticUpdate(markSyntheticUpdate(real))).toBe(true);
  });

  it("syntheticCommandUpdate is marked", () => {
    const update = syntheticCommandUpdate(
      { messageId: 1, chat: { id: 5, type: "private" } as never, from: { id: 5, is_bot: false, first_name: "F" } },
      { name: "tasks", args: "" },
    );
    expect(isSyntheticUpdate(update)).toBe(true);
  });
});

function ctxFor(text: string | undefined, update: Update, chatId = 99) {
  return {
    update,
    message: text === undefined ? undefined : { text, date: 1_759_700_000 },
    chat: { id: chatId },
    me: { username: BOT },
  } as unknown as Context;
}

describe("commandTurnRecorder", () => {
  const threadIdFor = (chatId: number | string) => "t:" + chatId;

  it("records a typed command under the chat's thread and still runs the command", async () => {
    const record = vi.fn<(threadId: string, turn: StoredTurn) => Promise<void>>().mockResolvedValue();
    const next = vi.fn().mockResolvedValue(undefined);
    await commandTurnRecorder(threadIdFor, { record })(ctxFor("/tasks", { update_id: 12 } as Update), next);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]![0]).toBe("t:99");
    expect(record.mock.calls[0]![1]).toMatchObject({ turn_id: "cmd-12", user_input: "/tasks", reply: "Ran /tasks" });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("does not record the update command-dispatch replays", async () => {
    const record = vi.fn().mockResolvedValue(undefined);
    const next = vi.fn().mockResolvedValue(undefined);
    const update = markSyntheticUpdate({ update_id: 13 } as Update);
    await commandTurnRecorder(threadIdFor, { record })(ctxFor("/tasks", update), next);
    expect(record).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("does not record plain text or non-message updates", async () => {
    const record = vi.fn().mockResolvedValue(undefined);
    const next = vi.fn().mockResolvedValue(undefined);
    const mw = commandTurnRecorder(threadIdFor, { record });
    await mw(ctxFor("hello there", { update_id: 14 } as Update), next);
    await mw(ctxFor(undefined, { update_id: 15 } as Update), next);
    expect(record).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(2);
  });

  it("a failed write never blocks the command", async () => {
    const record = vi.fn().mockRejectedValue(new Error("db down"));
    const next = vi.fn().mockResolvedValue(undefined);
    await commandTurnRecorder(threadIdFor, { record })(ctxFor("/tasks", { update_id: 16 } as Update), next);
    await new Promise((resolve) => setImmediate(resolve));
    expect(next).toHaveBeenCalledTimes(1);
  });
});
