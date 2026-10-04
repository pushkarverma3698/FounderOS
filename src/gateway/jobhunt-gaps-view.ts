/**
 * FounderOS — /gaps
 * =================
 * Moved out of jobhunt-view.ts, which was at its 400-line budget.
 */

import type { Context } from "grammy";
import { computeGaps, DEFAULT_GAP_TRACK, formatGapReport } from "../tools/jobhunt/gaps.js";
import { gapKeyboard } from "./jobhunt-gap-buttons.js";
import { resolveProfileArg, isProfileArgMiss } from "./jobhunt-profile-arg.js";
import { profileMissMessage } from "../tools/jobhunt/brief-resolver.js";
import type { JobSearchProfile } from "../tools/jobhunt/profile-config.js";
import { childLogger } from "../infra/logger.js";
import { safeHtml } from "./approval-card.js";

const log = childLogger({ module: "gateway:jobhunt-gaps-view" });

/**
 * Which track a `/gaps` report is about.
 *
 * READ OFF THE PROFILE, never off `DEFAULT_GAP_TRACK`. That constant is the
 * string "ai" — one of Pushkar's four tracks and none of Tashi's. Passing it for
 * her would measure the TECH market's vocabulary against her finance CV, and
 * `buildGapReport` would dutifully report every finance term as a gap and every
 * tech term as missing: confidently wrong in both directions at once.
 *
 * An unrecognised track falls back to the profile's own first track rather than
 * erroring. The founder typing `/gaps ai` at the wrong profile means "show me
 * the gaps", and the honest answer is her real market, labelled — `formatGapReport`
 * always prints the track it reported on.
 */
export function gapsTrackFor(profile: JobSearchProfile, rest: string): string {
  const asked = rest.trim().toLowerCase();
  const fallback = profile.trackPriority[0] ?? DEFAULT_GAP_TRACK;
  return asked.length > 0 && profile.tracks[asked] ? asked : fallback;
}

/**
 * `/gaps [who] [track]` — what the screened market asks for that the CV does not say.
 *
 * THE MISSING HALF OF `/draft`. Tailoring is bounded by a closed vocabulary: it
 * may only name technologies the base CV already states, so it CANNOT raise the
 * keyword coverage a recruiter's search runs against — by construction, not by
 * accident (see tailor-cv.ts). The only thing that moves that number is the
 * founder adding a term to his base CV, and this is the ranked list of which
 * terms are worth the decision.
 *
 * SUGGESTS ONLY. The report never edits a CV, and it must not: a term the CV
 * omits is either a wording gap or a real one, and the difference is a fact
 * about a person that nobody but that person can supply.
 */
export async function handleGaps(ctx: Context): Promise<void> {
  const selected = resolveProfileArg(ctx.match?.toString() ?? "", []);
  if (isProfileArgMiss(selected)) {
    await ctx.reply(profileMissMessage(selected));
    return;
  }

  const track = gapsTrackFor(selected.profile, selected.rest);
  try {
    const result = await computeGaps({ track, profile: selected.profile.id });
    if (!result.ok) {
      await ctx.reply(`❌ Couldn't build the gap report: ${safeHtml(result.error)}`, { parse_mode: "HTML" });
      return;
    }
    log.info({ track, profile: selected.profile.id }, "CV gap report requested");
    const keyboard = gapKeyboard(selected.profile.id, result.report.missing);
    await ctx.reply(formatGapReport(result.report, { track: result.track, cvPath: result.cvPath }), {
      ...(keyboard ? { reply_markup: keyboard } : {}),
    });
  } catch (err) {
    // Never silent — the whole reason this command exists is that the engine
    // behind it ran for a month with no way to reach it.
    log.error({ track, err: (err as Error).message }, "/gaps failed");
    await ctx.reply(`❌ Couldn't build the gap report: ${safeHtml((err as Error).message)}`, {
      parse_mode: "HTML",
    });
  }
}
