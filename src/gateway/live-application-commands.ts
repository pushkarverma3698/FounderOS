/**
 * FounderOS — /replied and /rejected
 * ===================================
 * Closes the loop `/applied` opens (jobhunt-commands.ts). Split into its own
 * file 2026-08-25 when adding it pushed jobhunt-commands.ts over the 400-line
 * budget — same precedent as apply-scrape.ts splitting out of apply-driver.ts.
 *
 * WHY NOT resolveBriefRow LIKE /applied: by the time a row is worth marking
 * replied/rejected, `/applied` has already cleared its brief_rank (see the
 * comment on `updateApplicationStage`'s `clearBriefRank` option) —
 * resolveBriefRow can structurally never find it again. These resolve against
 * `listLiveApplications()`'s own ordering instead, computed FRESH on every
 * call rather than pinned at render time.
 *
 * RANK-CHURN, deliberately accepted: if the live list shifts between when the
 * founder reads a digest and when he types the number, N could point at the
 * wrong row. The brief's own mitigation is the fix here too — the company
 * name is echoed back on every reply, so a stale number is visible, not
 * silent (the same rule `/applied` already follows).
 */

import type { Context } from "grammy";
import { updateApplicationStage, listLiveApplications } from "../db/job-queries.js";
import { parseRowArg } from "./jobhunt-commands.js";
import { resolveProfileArg, isProfileArgMiss, profileMissMessage } from "./jobhunt-profile-arg.js";
import { childLogger } from "../infra/logger.js";

const log = childLogger({ module: "gateway:live-application-commands" });

/**
 * Its own message rather than jobhunt-commands.ts's `unresolvedMessage`: that
 * one says "from the most recent brief only, ask me for the job brief" —
 * accurate for /draft or /applied, wrong here, since these two numbers come
 * from the live-pipeline list, not a brief.
 */
function unresolvedLiveApplicationMessage(command: "replied" | "rejected", rank: number | null): string {
  if (rank === null || rank < 1) {
    return `Usage: /${command} <number> — the number next to a row in your live applications list.\nExample: /${command} 1`;
  }
  return `No row ${rank} in your current live applications. Ask me for a pipeline review to get a current numbered list.`;
}

async function handleLiveApplicationCommand(
  ctx: Context,
  command: "replied" | "rejected",
  stage: "replied" | "rejected",
): Promise<void> {
  // A second profile means the live-applications list is per-candidate, same
  // as /jobs, /csv, /draft and /applied — without this, row N came from a
  // list merging both candidates' applications, so marking "row 2" could
  // silently touch the wrong person's application.
  const selected = resolveProfileArg(ctx.match?.toString() ?? "", [], (rest) => parseRowArg(rest) !== null);
  if (isProfileArgMiss(selected)) {
    await ctx.reply(profileMissMessage(selected));
    return;
  }

  const rank = parseRowArg(selected.rest);
  if (rank === null || rank < 1) {
    await ctx.reply(unresolvedLiveApplicationMessage(command, rank));
    return;
  }

  const live = await listLiveApplications({
    limit: 200,
    tenantId: selected.profile.tenantId,
    profileId: selected.profile.id,
  });
  const row = live[rank - 1];
  if (!row) {
    await ctx.reply(unresolvedLiveApplicationMessage(command, rank));
    return;
  }

  const updated = await updateApplicationStage(row.id, stage, { lastContactAt: new Date() });
  if (!updated) {
    await ctx.reply(`Couldn't update ${row.company} — no row with id ${row.id} found. Nothing changed.`);
    return;
  }

  log.info(
    { command, rank, company: row.company, id: row.id, profile: selected.profile.id },
    `Application marked ${stage}`,
  );
  const verb = stage === "replied" ? "replied" : "rejected";
  await ctx.reply(`✅ Marked ${verb} — ${row.company} (${row.title}).`);
}

export async function handleReplied(ctx: Context): Promise<void> {
  await handleLiveApplicationCommand(ctx, "replied", "replied");
}

export async function handleRejected(ctx: Context): Promise<void> {
  await handleLiveApplicationCommand(ctx, "rejected", "rejected");
}
