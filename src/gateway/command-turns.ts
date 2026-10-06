/**
 * FounderOS - a typed slash command is a turn too
 * ================================================
 * conversation_turns is what "what did I ask you today" reads. The kernel files a turn there only when
 * the NEXT kernel turn starts (the plan node folds the previous one in), and a slash command typed
 * straight at the bot never enters the kernel at all: /tasks, /where, /fresh answered the founder and left
 * no trace, so a later recall said he had asked nothing. The plain-words route (the planner routing "what
 * is running" to /tasks) is already recorded by the kernel; this covers the typed one.
 *
 * One row per typed command: his input, and "Ran /name args" as the reply summary, the same line the
 * planner's routed commands already leave. The command's own output is not copied: it is a live view of
 * something else, and the row only has to say that he asked.
 *
 * Skipped on purpose:
 *  - the synthetic updates command-dispatch.ts replays for a planner-routed command (the kernel already
 *    recorded that turn; recording it again would list one question twice);
 *  - /login and /connect (their arguments can carry credentials);
 *  - commands that start a kernel turn of their own (/task, /ask, /draft, /remind...): that turn is
 *    recorded by the kernel, with the instruction it actually ran;
 *  - names the bot does not answer to (a typo is not a command he ran).
 *
 * Fire and forget: a failed write is logged and costs a later recall, never the command he typed.
 */

import type { Context, MiddlewareFn } from "grammy";
import type { Update } from "grammy/types";
import { commandName } from "./chat-access.js";
import { COMMAND_MENU } from "./command-menu.js";
import { recordConversationTurn, type StoredTurn } from "../db/conversation-turns.js";
import { logger } from "../infra/logger.js";

const log = logger.child({ module: "command-turns" });

/** Commands whose arguments can carry credentials: never stored. */
const CREDENTIAL_COMMANDS: ReadonlySet<string> = new Set(["login", "connect"]);

/** Commands that hand the founder's text to the kernel: that turn is recorded there. */
const KERNEL_TURN_COMMANDS: ReadonlySet<string> = new Set([
  "task",
  "claude",
  "agy",
  "ask",
  "wife_ask",
  "draft",
  "wife_draft",
  "remind",
  "newproject",
]);

const ANSWERED_COMMANDS: ReadonlySet<string> = new Set(COMMAND_MENU.map((entry) => entry.command));

/** Longest argument text kept in the row. */
export const COMMAND_TURN_ARGS_MAX_CHARS = 500;

/** Updates command-dispatch.ts built itself, not Telegram: the kernel already recorded those turns. */
const synthetic = new WeakSet<object>();

export function markSyntheticUpdate(update: Update): Update {
  synthetic.add(update);
  return update;
}

export function isSyntheticUpdate(update: object): boolean {
  return synthetic.has(update);
}

/** What the middleware reads off an update: plain fields, so the decision below is a pure function. */
export interface TypedCommandInput {
  readonly updateId: number;
  readonly text: string;
  /** Telegram message.date, epoch seconds. */
  readonly dateSeconds?: number;
  readonly botUsername: string;
}

/** PURE: the row a typed command leaves, or null when it leaves none. */
export function typedCommandTurn(input: TypedCommandInput): StoredTurn | null {
  const name = commandName(input.text, input.botUsername);
  if (name === null || !ANSWERED_COMMANDS.has(name)) return null;
  if (CREDENTIAL_COMMANDS.has(name) || KERNEL_TURN_COMMANDS.has(name)) return null;
  const trimmed = input.text.trim();
  const gap = trimmed.search(/\s/);
  const args = gap === -1 ? "" : trimmed.slice(gap + 1).trim().slice(0, COMMAND_TURN_ARGS_MAX_CHARS);
  const line = "/" + name + (args ? " " + args : "");
  const at = input.dateSeconds ? new Date(input.dateSeconds * 1000) : new Date();
  return {
    turn_id: "cmd-" + input.updateId,
    at: at.toISOString(),
    user_input: line,
    goal: line,
    outcome: "done",
    reply: "Ran " + line,
  };
}

export interface CommandTurnDeps {
  readonly record?: (threadId: string, turn: StoredTurn) => Promise<void>;
}

/**
 * Middleware: file the typed command, then let it run. Installed after the access check, so a command the
 * bot refused (stranger, owner-only) is never recorded as one he ran.
 */
export function commandTurnRecorder(
  threadIdFor: (chatId: number | string) => string,
  deps: CommandTurnDeps = {},
): MiddlewareFn<Context> {
  const record = deps.record ?? recordConversationTurn;
  return async (ctx, next) => {
    const text = ctx.message?.text;
    if (text && ctx.chat && !isSyntheticUpdate(ctx.update)) {
      const turn = typedCommandTurn({
        updateId: ctx.update.update_id,
        text,
        ...(ctx.message?.date ? { dateSeconds: ctx.message.date } : {}),
        botUsername: ctx.me.username,
      });
      if (turn) {
        // allow-failopen: a lost history row costs a later recall; it must never cost the founder his command
        void record(threadIdFor(ctx.chat.id), turn).catch((err: unknown) => {
          log.warn({ err: String(err), turn_id: turn.turn_id }, "Typed command not recorded");
        });
      }
    }
    await next();
  };
}
