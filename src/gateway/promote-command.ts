/**
 * FounderOS — /promote: beta to prod from Telegram
 * ================================================
 * `/promote` reads what beta has that main lacks (read-only), shows it on one card, and waits for ONE tap. The tap
 * hands the job to `deploy/job-run` (stage=promote) through the fos-job socket; that job opens the promotion PR,
 * waits for green CI, merges it with a merge commit, waits for the Deploy workflow and checks the box. It sends its
 * own outcome message. The bot never merges and never touches /opt/founderos.
 *
 * Owner-only twice over: the command is in OWNER_ONLY_COMMANDS (the transport refuses a guest), and the buttons check
 * the same thing on every tap. The tap authorises the beta commit printed on the card: if beta moved, the card is
 * stale and nothing starts.
 *
 * Registered from telegram.ts with ONE call, `registerPromoteCommand(bot, access)`.
 */

import type { Bot, Context } from "grammy";
import { Octokit } from "octokit";
import { TENANT } from "../core/config.js";
import { writeAuditEntry } from "../db/queries.js";
import { childLogger } from "../infra/logger.js";
import { startPromoteJob, type StartJobResult } from "../tools/dispatch-tick.js";
import { PROMOTE_TARGETS, planFromCompare, promoteCardText, promoteTargetByKey, type PromoteKey, type PromoteTarget } from "../tools/promote-plan.js";
import { classifyChatAccess, mayActAsOwner, type ChatAccessConfig } from "./chat-access.js";

const log = childLogger({ module: "gateway:promote" });

export const PROMOTE_CALLBACK_PREFIX = "pm:";
export const PROMOTE_AUDIT_ACTION = "promote_start";
// `pm:y:<sha>` is FounderOS (the original card); `pm:y:<key>:<sha>` names another target. Telegram caps callback data at 64 bytes.
const CALLBACK_YES_RE = /^pm:y:(?:([a-z-]+):)?([0-9a-f]{40})$/;

export interface PromoteDeps {
  /** Beta's head and the compare result <base>...<that head>. Throws when the hosting API cannot be read. */
  read(target: PromoteTarget): Promise<{ betaSha: string; compare: unknown }>;
  start(target: PromoteTarget, betaSha: string): Promise<StartJobResult>;
  /** Written only after the job was handed over. */
  audit(target: PromoteTarget, betaSha: string, messageId: number): Promise<void>;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const livePromoteDeps: PromoteDeps = {
  async read(target) {
    const token = process.env["GITHUB_TOKEN"];
    if (!token) throw new Error("GITHUB_TOKEN is not set");
    const octokit = new Octokit({ auth: token });
    const [owner, repo] = target.repo.split("/") as [string, string];
    const branch = await octokit.rest.repos.getBranch({ owner, repo, branch: "beta" });
    const betaSha = branch.data.commit.sha;
    const { data } = await octokit.rest.repos.compareCommitsWithBasehead({ owner, repo, basehead: `${target.base}...${betaSha}`, per_page: 100 });
    return { betaSha, compare: data };
  },
  start: (target, betaSha) => startPromoteJob(target.repo, betaSha),
  async audit(target, betaSha, messageId) {
    await writeAuditEntry({
      tenant_id: TENANT,
      action: PROMOTE_AUDIT_ACTION,
      // One row per card tap: a redelivered update cannot write a second.
      idempotency_key: `${PROMOTE_AUDIT_ACTION}:${betaSha}:${messageId}`,
      payload: { repo: target.repo, beta_sha: betaSha, via: "telegram-card" },
    });
  },
};

/** Cards whose Promote tap is being processed (chat:message). Marked before any await, so a double tap starts one job. */
const claimed = new Set<string>();
export function _resetPromoteClaimsForTests(): void {
  claimed.clear();
}

const NAMES = Object.keys(PROMOTE_TARGETS).join(", ");

/** `/promote [name]`: read, then either say there is nothing to promote or post the card. Starts nothing. */
export async function handlePromote(ctx: Context, deps: PromoteDeps): Promise<void> {
  const typed = typeof ctx.match === "string" ? ctx.match : "";
  const picked = promoteTargetByKey(typed);
  if (!picked) {
    await ctx.reply(`I can promote: ${NAMES}. "${typed.trim().slice(0, 40)}" is not one of them. Nothing was started.`);
    return;
  }
  const { key, target } = picked;
  const label = key === "founderos" ? "" : `(${key})`;
  let read: { betaSha: string; compare: unknown };
  try {
    read = await deps.read(target);
  } catch (err) {
    log.error({ err: errText(err) }, "promote: could not read beta and main");
    await ctx.reply(`Could not read beta and main: ${errText(err)}. Nothing was started.`);
    return;
  }
  const plan = planFromCompare(read.compare, read.betaSha, target.base);
  if (plan === null) {
    await ctx.reply(`Nothing to promote${label ? ` ${label}` : ""}: ${target.base} already has every change on beta (beta ${read.betaSha.slice(0, 7)}).`);
    return;
  }
  await ctx.reply(promoteCardText(plan, label), {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Promote now", callback_data: `${PROMOTE_CALLBACK_PREFIX}y:${key === "founderos" ? "" : `${key}:`}${plan.betaSha}` },
          { text: "Cancel", callback_data: `${PROMOTE_CALLBACK_PREFIX}n` },
        ],
      ],
    },
  });
}

/** Replace the card's text and drop its buttons. A failed edit only leaves stale buttons; the tap already worked. */
async function closeCard(ctx: Context, text: string): Promise<void> {
  try {
    await ctx.editMessageText(text, { reply_markup: { inline_keyboard: [] } });
  } catch (err) {
    // allow-failopen: the tap was already answered; a failed edit only leaves the buttons on screen, and the claim set refuses a second tap
    log.warn({ err: errText(err) }, "promote: could not edit the card");
  }
}

/**
 * The card's buttons. Returns false for anything that is not a promote button so the next handler sees it. The owner
 * check comes first: a guest in an allow-listed group who taps a forwarded card gets a refusal and nothing starts.
 */
export async function handlePromoteCallback(ctx: Context, access: ChatAccessConfig, deps: PromoteDeps): Promise<boolean> {
  const data = ctx.callbackQuery?.data ?? "";
  if (!data.startsWith(PROMOTE_CALLBACK_PREFIX)) return false;

  const who = classifyChatAccess({ chatId: ctx.chat?.id, chatType: ctx.chat?.type, fromId: ctx.from?.id }, access);
  if (!mayActAsOwner(who, ctx.from?.id, access)) {
    await ctx.answerCallbackQuery({ text: "Only the owner can promote.", show_alert: true });
    return true;
  }
  if (data === `${PROMOTE_CALLBACK_PREFIX}n`) {
    await ctx.answerCallbackQuery({ text: "Cancelled." });
    await closeCard(ctx, "Promotion cancelled. Nothing changed.");
    return true;
  }
  const yes = CALLBACK_YES_RE.exec(data);
  const betaSha = yes?.[2];
  const picked = promoteTargetByKey(yes?.[1] ?? "");
  const messageId = ctx.callbackQuery?.message?.message_id;
  if (betaSha === undefined || picked === null || messageId === undefined) {
    await ctx.answerCallbackQuery({ text: "That button is not valid any more. Send /promote for a fresh card.", show_alert: true });
    return true;
  }

  const key = `${ctx.chat?.id}:${messageId}`;
  if (claimed.has(key)) {
    await ctx.answerCallbackQuery({ text: "Already started: one message follows when it is done." });
    return true;
  }
  claimed.add(key);
  const { target } = picked;
  let started = false;
  try {
    const now = await deps.read(target);
    if (now.betaSha !== betaSha) {
      await ctx.answerCallbackQuery({ text: "Beta moved since this card.", show_alert: true });
      await closeCard(ctx, `Beta moved to ${now.betaSha.slice(0, 7)} since this card (it showed ${betaSha.slice(0, 7)}). Nothing started. Send /promote for a fresh card.`);
      return true;
    }
    const result = await deps.start(target, betaSha);
    if (result.status === "started") {
      started = true;
      await ctx.answerCallbackQuery({ text: "Promoting…" });
      await closeCard(ctx, `Promoting beta ${betaSha.slice(0, 7)} to ${target.base}. One message follows when prod has moved, or where it stopped.`);
      await deps.audit(target, betaSha, messageId).catch((err: unknown) => log.error({ err: errText(err) }, "promote: audit row not written"));
    } else if (result.status === "inert") {
      await ctx.answerCallbackQuery({ text: "This host does not run jobs.", show_alert: true });
    } else {
      await ctx.answerCallbackQuery({ text: "Could not start.", show_alert: true });
      await ctx.reply(`Could not start the promotion: ${result.reason}. Nothing is running it. On the VPS check \`systemctl status fos-job.socket\`; tap the card again to retry.`);
    }
  } catch (err) {
    log.error({ err: errText(err) }, "promote: tap failed");
    await ctx.answerCallbackQuery({ text: `Could not start: ${errText(err)}`.slice(0, 190), show_alert: true });
  } finally {
    if (!started) claimed.delete(key);
  }
  return true;
}

/** Register /promote and its buttons. Callbacks that are not promote buttons go on with `next()`. */
export function registerPromoteCommand(bot: Bot, access: ChatAccessConfig, deps: PromoteDeps = livePromoteDeps): void {
  bot.command("promote", (ctx: Context) => handlePromote(ctx, deps));
  bot.on("callback_query:data", async (ctx, next) => {
    if (!(await handlePromoteCallback(ctx, access, deps))) await next();
  });
}
