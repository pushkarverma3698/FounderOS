/**
 * FounderOS — the "add to CV?" buttons under /gaps
 * ================================================
 * Each real gap gets a tap. The tap does NOT edit the CV: cv_gaps is read-only by
 * design (ADR-015), and whether a term is true is a fact about the person that
 * nobody but them can supply. It answers with the one edit to make and what
 * happens next, so the decision takes a tap instead of a re-read of the report.
 */

import { InlineKeyboard } from "grammy";
import type { SignalRow } from "../tools/jobhunt/gaps.js";
import { safeHtml } from "./safe-html.js";

const PREFIX = "jh:g:";
/** Buttons under one report: the top of the list, not all of it. */
export const GAP_BUTTON_COUNT = 3;

/** One "➕ Add <term>" button per missing term (top three). Terms that overflow Telegram's 64-byte cap are skipped; null when no button fits. */
export function gapKeyboard(profileId: string, missing: readonly Pick<SignalRow, "term">[]): InlineKeyboard | null {
  const kb = new InlineKeyboard();
  let shown = 0;
  for (const m of missing) {
    const data = `${PREFIX}${profileId}:${m.term}`;
    if (Buffer.byteLength(data) > 64) continue;
    if (shown > 0) kb.row();
    kb.text(`➕ Add ${m.term.slice(0, 30)} to CV?`, data);
    if (++shown === GAP_BUTTON_COUNT) break;
  }
  return shown > 0 ? kb : null;
}

export function parseGapCallback(data: string): { profileId: string; term: string } | null {
  if (!data.startsWith(PREFIX)) return null;
  const rest = data.slice(PREFIX.length);
  const cut = rest.indexOf(":");
  const profileId = rest.slice(0, cut);
  const term = rest.slice(cut + 1);
  return cut > 0 && term ? { profileId, term } : null;
}

/** What a tap says. Honest about the boundary: the bot reports the gap, the founder decides what is true. */
export function gapAddReply(term: string): string {
  return (
    `➕ <b>${safeHtml(term)}</b>\n` +
    `Add it to the Skills line of your CV only if you have really used it. I won't edit the CV ` +
    `for you — that is yours to state. Run /gaps again afterwards and it moves to CONFIRMED.`
  );
}
