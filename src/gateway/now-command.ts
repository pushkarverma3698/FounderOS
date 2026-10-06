/**
 * FounderOS — /now, and where /commands is registered
 * ===================================================
 * One screen across the three things the founder checks in turn: coding (what the agent loop is doing and
 * what needs him), jobs (roles ready to apply to) and ops (approvals waiting). Three lines, one button each.
 * Each button opens the existing command, so nothing here is a second source of truth.
 *
 * Named `/now`, not `/today`: `/today` already means "roles an employer published in the last 24h" and
 * moving it would break the job loop.
 *
 * A section that cannot be read says so on its own line. A zero printed for a failed read would look like an
 * empty queue.
 *
 * `/now` is owner-only (OWNER_ONLY_COMMANDS), and so are its buttons, checked on every tap.
 */

import type { Bot, Context } from "grammy";
import { DISPATCH_REPO_ALLOWLIST } from "../tools/dispatch-repos.js";
import { listApplyQueue } from "../db/apply-queries.js";
import { DEFAULT_PROFILE_ID, getProfile } from "../tools/jobhunt/profile-config.js";
import { childLogger } from "../infra/logger.js";
import { classifyChatAccess, mayActAsOwner, type ChatAccessConfig } from "./chat-access.js";
import { handleCommands, handleStatus } from "./commands.js";
import { sendCompactBrief, topRolesFor } from "./jobhunt-compact.js";
import { fetchDispatchTasks, handleTasks } from "./tasks-command.js";
import { getSystemStatus } from "./status.js";

const log = childLogger({ module: "gateway:now" });

export const NOW_CALLBACK_PREFIX = "now:";

interface Section {
  /** Set when the read failed; the line then says so instead of printing counts. */
  readonly error?: string;
}
export interface NowData {
  readonly coding: Section & { working: number; needsYou: number; readyToMerge: number; unreachable: number };
  readonly jobs: Section & { ready: number; profileId: string };
  readonly ops: Section & { pendingApprovals: number };
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** The message. Pure. */
export function formatNow(d: NowData): string {
  const c = d.coding;
  const coding = c.error
    ? `⚠ couldn't read the repos (${c.error})`
    : [
        c.working + c.needsYou + c.readyToMerge === 0 ? "nothing running" : "",
        c.working > 0 ? `${c.working} working` : "",
        c.needsYou > 0 ? `${c.needsYou} needs you` : "",
        c.readyToMerge > 0 ? `${c.readyToMerge} ready to merge` : "",
        c.unreachable > 0 ? `${plural(c.unreachable, "repo", "repos")} unreadable` : "",
      ]
        .filter(Boolean)
        .join(" · ");
  const jobs = d.jobs.error
    ? `⚠ couldn't read the queue (${d.jobs.error})`
    : d.jobs.ready === 0
      ? "no roles ready to apply to"
      : `${d.jobs.ready} ready to apply`;
  const ops = d.ops.error
    ? `⚠ couldn't read approvals (${d.ops.error})`
    : d.ops.pendingApprovals === 0
      ? "nothing waiting on you"
      : `${d.ops.pendingApprovals} waiting on your approval`;
  return `<b>Right now</b>\n\n🤖 Coding: ${coding}\n🎯 Jobs: ${jobs}\n⚡ Ops: ${ops}`;
}

/** One button per line, in line order. */
export function nowKeyboardRows(d: NowData): { text: string; callback_data: string }[][] {
  return [
    [{ text: "🤖 Open tasks", callback_data: `${NOW_CALLBACK_PREFIX}tasks` }],
    [{ text: d.jobs.ready > 0 ? "📝 Top roles" : "🎯 Open jobs", callback_data: `${NOW_CALLBACK_PREFIX}jobs` }],
    [{ text: "⚡ Open status", callback_data: `${NOW_CALLBACK_PREFIX}status` }],
  ];
}

const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 80);

export async function readNow(): Promise<NowData> {
  const profileId = DEFAULT_PROFILE_ID;
  const [coding, jobs, ops] = await Promise.all([
    fetchDispatchTasks(DISPATCH_REPO_ALLOWLIST).then(
      (v): NowData["coding"] => ({
        working: v.rows.filter((r) => r.state === "working" || r.state === "review" || r.state === "ready").length,
        needsYou: v.rows.filter((r) => r.state === "blocked" || r.state === "failed").length,
        readyToMerge: v.readyToMerge?.length ?? 0,
        unreachable: v.unreachable.length,
      }),
      (err): NowData["coding"] => ({ working: 0, needsYou: 0, readyToMerge: 0, unreachable: 0, error: reason(err) }),
    ),
    listApplyQueue(getProfile(profileId).tenantId, profileId).then(
      (rows): NowData["jobs"] => ({ ready: rows.filter((r) => r.brief_section === "do_today").length, profileId }),
      (err): NowData["jobs"] => ({ ready: 0, profileId, error: reason(err) }),
    ),
    getSystemStatus().then(
      (s): NowData["ops"] => ({ pendingApprovals: s.pendingApprovals }),
      (err): NowData["ops"] => ({ pendingApprovals: 0, error: reason(err) }),
    ),
  ]);
  return { coding, jobs, ops };
}

export async function handleNow(ctx: Context): Promise<void> {
  const data = await readNow();
  await ctx.reply(formatNow(data), {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: nowKeyboardRows(data) },
  });
}

async function handleNowCallback(ctx: Context, access: ChatAccessConfig): Promise<boolean> {
  const data = ctx.callbackQuery?.data ?? "";
  if (!data.startsWith(NOW_CALLBACK_PREFIX)) return false;
  const who = classifyChatAccess({ chatId: ctx.chat?.id, chatType: ctx.chat?.type, fromId: ctx.from?.id }, access);
  if (!mayActAsOwner(who, ctx.from?.id, access)) {
    await ctx.answerCallbackQuery({ text: "Only the owner can use this." });
    return true;
  }
  await ctx.answerCallbackQuery();
  const target = data.slice(NOW_CALLBACK_PREFIX.length);
  if (target === "tasks") await handleTasks(ctx);
  else if (target === "status") await handleStatus(ctx);
  else if (target === "jobs") {
    const sent = await sendCompactBrief(ctx, getProfile(DEFAULT_PROFILE_ID), "jobs", false, topRolesFor);
    if (!sent) await ctx.reply("No roles are ready to apply to right now. Send /jobs for the full queue and why.");
  } else log.warn({ target }, "Unknown /now button");
  return true;
}

/** Register /commands, /now and the /now buttons. Called once from telegram.ts, before the catch-all handlers. */
export function registerHomeCommands(bot: Bot, access: ChatAccessConfig): void {
  bot.command("commands", (ctx: Context) => handleCommands(ctx));
  bot.command("now", (ctx: Context) => handleNow(ctx));
  bot.on("callback_query:data", async (ctx, next) => {
    if (!(await handleNowCallback(ctx, access))) await next();
  });
}
