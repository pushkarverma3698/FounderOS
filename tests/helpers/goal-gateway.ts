/**
 * Fakes for the goal gateway tests: a grammy Context that records what was said and answered, and the
 * command dependencies over the in-memory repository. No Telegram, no Postgres, no kernel.
 */

import { vi } from "vitest";
import type { Context } from "grammy";
import { PickerGuard, PlanGuard, type GoalCommandDeps } from "../../src/gateway/goal-deps.js";
import type { SkipLedger } from "../../src/goals/skipped.js";
import { InMemoryGoalRepo } from "./fake-goal-repo.js";
import { NINE_AM, TZ, makeMetricDeps } from "./goal-fixtures.js";

export const OWNER = 4242;
export const GUEST = 7777;
export const PRIMARY_CHAT = 4242;
export const ALLOWED_GROUP = -100555;

export interface Reply {
  text: string;
  opts: { parse_mode?: string; reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] }; reply_parameters?: { message_id: number; allow_sending_without_reply?: boolean } } | undefined;
}

export interface CtxOptions {
  readonly match?: string;
  readonly messageId?: number;
  readonly fromId?: number;
  readonly chatId?: number;
  readonly chatType?: "private" | "supergroup";
  /** A callback tap: its data, and the message the button sits on (with the message it replies to). */
  readonly callback?: { data: string; messageId?: number; replyTo?: { text?: string; message_id: number } };
}

export function makeCtx(o: CtxOptions = {}) {
  const replies: Reply[] = [];
  const answers: { text?: string; show_alert?: boolean }[] = [];
  const edits: unknown[] = [];
  const chatId = o.chatId ?? PRIMARY_CHAT;
  const ctx = {
    match: o.match ?? "",
    message: { message_id: o.messageId ?? 10 },
    chat: { id: chatId, type: o.chatType ?? (chatId > 0 ? "private" : "supergroup") },
    from: { id: o.fromId ?? OWNER },
    callbackQuery: o.callback
      ? {
          data: o.callback.data,
          message: {
            message_id: o.callback.messageId ?? 50,
            ...(o.callback.replyTo ? { reply_to_message: o.callback.replyTo } : {}),
          },
        }
      : undefined,
    reply: vi.fn(async (text: string, opts?: Reply["opts"]) => {
      replies.push({ text, opts });
      return { message_id: 1000 + replies.length };
    }),
    answerCallbackQuery: vi.fn(async (opts?: { text?: string; show_alert?: boolean }) => void answers.push(opts ?? {})),
    editMessageReplyMarkup: vi.fn(async (opts: unknown) => void edits.push(opts)),
  };
  return { ctx: ctx as unknown as Context, replies, answers, edits };
}

export class MemorySkips implements SkipLedger {
  dates: string[] = [];
  async record(date: string): Promise<void> {
    if (!this.dates.includes(date)) this.dates.push(date);
  }
  async take(): Promise<string[]> {
    const out = [...this.dates].sort();
    this.dates = [];
    return out;
  }
}

export function makeDeps(over: Partial<GoalCommandDeps> = {}) {
  const repo = new InMemoryGoalRepo();
  const metrics = makeMetricDeps();
  const skips = new MemorySkips();
  const kernel: { prompts: string[] } = { prompts: [] };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const deps: GoalCommandDeps = {
    repo: vi.fn(async () => repo),
    metrics: vi.fn(async () => metrics),
    runKernelText: vi.fn(async (_ctx: Context, text: string) => void kernel.prompts.push(text)),
    now: () => NINE_AM,
    timeZone: () => TZ,
    tenant: "t",
    profiles: () => ({
      ids: ["pushkar-nl-tech", "wife-nl-finance"],
      resolve: (token: string) => (["pushkar-nl-tech", "wife-nl-finance"].includes(token.toLowerCase()) ? token.toLowerCase() : token.toLowerCase() === "tashi" ? "wife-nl-finance" : null),
    }),
    repoChoices: vi.fn(async () => ["pushkarverma3698/FounderOS", "pushkarverma3698/House-of-Hulda-Website-frontend"]),
    skips: () => skips,
    planGuard: new PlanGuard(),
    pickerGuard: new PickerGuard(),
    log,
    ...over,
  };
  return { deps, repo, metrics, skips, kernel, log };
}

export type GoalHarness = ReturnType<typeof makeDeps>;

/** Add a goal straight to the repository (creation times one second apart so the list order is stable). */
let seq = 0;
export function seedGoal(h: GoalHarness, over: Partial<Parameters<InMemoryGoalRepo["addGoal"]>[1]> = {}) {
  return h.repo.addGoal(
    "t",
    { title: "A goal", metric_key: "manual", metric_arg: null, target: 5, baseline: 0, due_on: null, priority: 100, ...over },
    new Date(new Date("2026-09-01T08:00:00Z").getTime() + seq++ * 1000),
  );
}
