/**
 * /autoapply on|off|status: the per-profile runtime switch for auto-send (ADR-018 amendment 2026-11-15)
 * ====================================================================================================
 * Both this switch and the env switch AUTO_APPLY_SEND=on must be on before anything is sent. `off` is the kill
 * switch: it takes effect on the next row of the next pass. `/autoapply tashi status` names the profile.
 */

import { InlineKeyboard, type Context } from "grammy";
import { loadAutoSendHistory, recentAutoSends, type AutoSendLogEntry } from "../db/job-auto-send-queries.js";
import { autoSendEnvOn, dailyCapFrom } from "../tools/jobhunt/auto-send-rules.js";
import { readRuntimeSwitch, writeRuntimeSwitch } from "../tools/jobhunt/auto-send-switch.js";
import { listProfiles } from "../tools/jobhunt/profile-config.js";
import { JOB_CALLBACK_PREFIX } from "../tools/jobhunt/job-ref.js";
import { isProfileArgMiss, profileMissMessage, resolveProfileArg } from "./jobhunt-profile-arg.js";
import { safeHtml } from "./safe-html.js";

export type AutoApplyVerb = "on" | "off" | "status";

export function parseAutoApplyVerb(rest: string): AutoApplyVerb | null {
  const word = rest.trim().toLowerCase();
  return word === "on" || word === "off" || word === "status" || word === "" ? (word === "" ? "status" : word) : null;
}

export interface AutoApplyStatus {
  readonly profileId: string;
  readonly envOn: boolean;
  readonly runtimeOn: boolean;
  readonly sentToday: number;
  readonly cap: number;
  readonly last: readonly AutoSendLogEntry[];
}

export function renderAutoApplyStatus(s: AutoApplyStatus): string {
  const on = s.envOn && s.runtimeOn;
  const lines = [`<b>Auto-apply (${safeHtml(s.profileId)}): ${on ? "ON, sends without a tap" : "OFF, nothing is sent"}</b>`];
  if (s.envOn !== s.runtimeOn || !on) {
    lines.push(`Server switch ${s.envOn ? "on" : "off"}, your switch ${s.runtimeOn ? "on" : "off"}. Both must be on.`);
  }
  lines.push(`Today: ${s.sentToday} of ${s.cap}.`);
  if (s.last.length > 0) {
    lines.push("Last sends:");
    for (const e of s.last) lines.push(`• ${e.at.toISOString().slice(0, 16).replace("T", " ")} UTC ${safeHtml(e.company)}, ${safeHtml(e.title)}: ${safeHtml(e.result)}`);
  }
  return lines.join("\n");
}

const AA_PREFIX = `${JOB_CALLBACK_PREFIX}aa:`;

/** One tap to flip the switch: the opposite of what is on now, plus a refresh. Payload `jh:aa:<on|off|status>:<profileId>`. */
export function autoApplyKeyboard(s: Pick<AutoApplyStatus, "profileId" | "runtimeOn">): InlineKeyboard {
  const flip = s.runtimeOn ? ["🛑 Turn off", "off"] : ["✅ Turn on", "on"];
  return new InlineKeyboard().text(flip[0] as string, `${AA_PREFIX}${flip[1]}:${s.profileId}`).text("🔄 Refresh", `${AA_PREFIX}status:${s.profileId}`);
}

export function parseAutoApplyCallback(data: string): { verb: AutoApplyVerb; profileId: string } | null {
  if (!data.startsWith(AA_PREFIX)) return null;
  const [verb, ...rest] = data.slice(AA_PREFIX.length).split(":");
  const profileId = rest.join(":");
  if ((verb !== "on" && verb !== "off" && verb !== "status") || !profileId) return null;
  return { verb, profileId };
}

async function statusFor(profileId: string): Promise<AutoApplyStatus> {
  const history = await loadAutoSendHistory(profileId, new Date());
  return {
    profileId,
    envOn: autoSendEnvOn(),
    runtimeOn: await readRuntimeSwitch(profileId),
    sentToday: history.sentToday,
    cap: dailyCapFrom(),
    last: await recentAutoSends(profileId, 5),
  };
}

/** The On/Off/Refresh tap: same write as the typed verb, then the status message is redrawn in place. */
export async function handleAutoApplyTap(ctx: Context, tap: { verb: AutoApplyVerb; profileId: string }): Promise<void> {
  if (!listProfiles().some((p) => p.id === tap.profileId)) {
    await ctx.answerCallbackQuery({ text: "That button is out of date." });
    return;
  }
  if (tap.verb !== "status") await writeRuntimeSwitch(tap.profileId, tap.verb === "on");
  const status = await statusFor(tap.profileId);
  await ctx.answerCallbackQuery({ text: tap.verb === "status" ? "Refreshed" : `Auto-apply ${tap.verb}` });
  await ctx.editMessageText(renderAutoApplyStatus(status), { parse_mode: "HTML", reply_markup: autoApplyKeyboard(status) }).catch(
    // allow-failopen: Telegram refuses an edit that changes nothing; the switch state is already written.
    () => undefined,
  );
}

export async function handleAutoApplySwitch(ctx: Context): Promise<void> {
  const parsed = resolveProfileArg(ctx.match?.toString() ?? "", ["on", "off", "status"]);
  if (isProfileArgMiss(parsed)) {
    await ctx.reply(profileMissMessage(parsed), { parse_mode: "HTML" });
    return;
  }
  const verb = parseAutoApplyVerb(parsed.rest);
  if (!verb) {
    await ctx.reply("Say on, off or status.", { reply_markup: autoApplyKeyboard({ profileId: parsed.profile.id, runtimeOn: false }) });
    return;
  }
  const profileId = parsed.profile.id;
  if (verb !== "status") await writeRuntimeSwitch(profileId, verb === "on");
  const status = await statusFor(profileId);
  await ctx.reply(renderAutoApplyStatus(status), { parse_mode: "HTML", reply_markup: autoApplyKeyboard(status) });
}
