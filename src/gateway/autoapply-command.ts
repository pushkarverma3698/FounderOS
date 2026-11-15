/**
 * /autoapply on|off|status: the per-profile runtime switch for auto-send (ADR-018 amendment 2026-11-15)
 * ====================================================================================================
 * Both this switch and the env switch AUTO_APPLY_SEND=on must be on before anything is sent. `off` is the kill
 * switch: it takes effect on the next row of the next pass. `/autoapply tashi status` names the profile.
 */

import type { Context } from "grammy";
import { loadAutoSendHistory, recentAutoSends, type AutoSendLogEntry } from "../db/job-auto-send-queries.js";
import { autoSendEnvOn, dailyCapFrom } from "../tools/jobhunt/auto-send-rules.js";
import { readRuntimeSwitch, writeRuntimeSwitch } from "../tools/jobhunt/auto-send-switch.js";
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
  const state = s.envOn && s.runtimeOn ? "ON: sends without a tap" : "OFF: nothing is sent";
  const lines = [
    `<b>Auto-apply (${safeHtml(s.profileId)}): ${state}</b>`,
    `Env AUTO_APPLY_SEND: ${s.envOn ? "on" : "off"}. /autoapply switch: ${s.runtimeOn ? "on" : "off"}. Both must be on.`,
    `Today: ${s.sentToday} of ${s.cap}.`,
  ];
  if (s.last.length === 0) lines.push("No sends yet.");
  else {
    lines.push("Last sends:");
    for (const e of s.last) lines.push(`• ${e.at.toISOString().slice(0, 16).replace("T", " ")} UTC ${safeHtml(e.company)}, ${safeHtml(e.title)}: ${safeHtml(e.result)}`);
  }
  return lines.join("\n");
}

export async function handleAutoApplySwitch(ctx: Context): Promise<void> {
  const parsed = resolveProfileArg(ctx.match?.toString() ?? "", ["on", "off", "status"]);
  if (isProfileArgMiss(parsed)) {
    await ctx.reply(profileMissMessage(parsed), { parse_mode: "HTML" });
    return;
  }
  const verb = parseAutoApplyVerb(parsed.rest);
  if (!verb) {
    await ctx.reply("Usage: /autoapply on, /autoapply off or /autoapply status (add a profile word first for another candidate).");
    return;
  }
  const profileId = parsed.profile.id;
  if (verb !== "status") await writeRuntimeSwitch(profileId, verb === "on");
  const now = new Date();
  const history = await loadAutoSendHistory(profileId, now);
  const status: AutoApplyStatus = {
    profileId,
    envOn: autoSendEnvOn(),
    runtimeOn: await readRuntimeSwitch(profileId),
    sentToday: history.sentToday,
    cap: dailyCapFrom(),
    last: await recentAutoSends(profileId, 5),
  };
  await ctx.reply(renderAutoApplyStatus(status), { parse_mode: "HTML" });
}
