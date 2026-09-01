/**
 * FounderOS — the brief's closing block, and the overflow notes
 * ==============================================================
 * Everything the brief says about WHAT TO DO, separated from everything it says
 * about WHAT WAS FOUND.
 *
 * Split out of brief.ts on 2026-08-24, when widening the apply queue from 24
 * hours to 7 days pushed that file past its 400-line budget. Same precedent as
 * brief-sections.ts, brief-select.ts and brief-cv.ts, and the same reason: this
 * is the block the founder acts from, so it is worth being able to read it
 * without the 300 lines of rendering that precede it.
 *
 * Pure. No database, no network, no model — every input is passed in.
 */

import { cmd, esc } from "./telegram-format.js";
import type { BriefRow } from "./brief-row.js";

/**
 * The exact command that runs the Mac apply client.
 *
 * DECLARED ONCE, here, and imported by both the brief's HOW TO APPLY block and
 * the gateway's `/draft` packet message. Both used to spell it themselves — one
 * of them as the bare phrase "run the Mac Client", which names a thing without
 * saying how to start it, on a phone where `mac-client/README.md` is not open.
 * Two hand-written copies of a path drift, and the direction they drift in is
 * "the command printed in Telegram no longer exists on disk".
 *
 * It lives on this side of the import boundary because the direction only runs
 * one way (contracts ← kernel ← gateway) and the gateway is what imports it.
 */
export const MAC_CLIENT_COMMAND =
  "cd ~/Projects/founderos/mac-client && .venv/bin/python -m mac_client.apply";

/**
 * "…and 41 more" — stated with the number AND the range, never a silent cut.
 *
 * The range is what changed on 2026-08-24. Hidden rows used to be genuinely
 * unreachable — `persistBriefRanks` pinned only the capped selection — so "ask
 * again after clearing these" was the only honest advice available. They are now
 * pinned and addressable, so the note names the numbers they answer to.
 * Otherwise the founder reads six rows, sees the next section open at 48, and
 * has no way to learn that `/draft 23` resolves to a real company.
 *
 * `startAt` is the rank of the first row shown, so the arithmetic is right for a
 * section that does not begin at 1.
 */
export function overflowNote(
  total: number,
  shown: number,
  what: string,
  startAt = 1,
): string {
  if (total <= shown) return "";
  const firstHidden = startAt + shown;
  const lastHidden = startAt + total - 1;
  const range = firstHidden === lastHidden ? `${firstHidden}` : `${firstHidden}–${lastHidden}`;
  return (
    `\n\n<i>+ ${total - shown} more ${what} — they are rows ${range}. ` +
    `<code>/draft ${firstHidden}</code> works on any of them; <code>/csv</code> lists them all.</i>`
  );
}

/**
 * The closing block: every command the founder can run right now, spelled out.
 *
 * The brief's whole purpose is to end in an action, and "▸ /draft 1" buried
 * beside row one is easy to scroll past. Collecting the commands at the bottom —
 * where reading stops — with the company each one targets means the last thing
 * on screen is a list of things to do, not a summary of things that happened.
 */
export function renderNextActions(
  doToday: readonly BriefRow[],
  stretch: readonly BriefRow[],
  askable: readonly BriefRow[],
  /** The UNCAPPED do-today count — the offset `briefRankEntries` pinned against. */
  doTodayTotal: number,
  standing: readonly BriefRow[] = [],
  /** The UNCAPPED stretch count — standing continues from do-today + stretch. */
  stretchTotal = stretch.length,
): string {
  const lines = [
    ...doToday.map((r, i) => `${cmd(`/draft ${i + 1}`)} — apply to ${esc(r.company)}`),
    // Numbered as a CONTINUATION of do-today, because `/draft` resolves across
    // both sections as one run. Restarting at 1 would make `/draft 1` ambiguous.
    ...stretch.map(
      (r, i) =>
        `${cmd(`/draft ${doTodayTotal + i + 1}`)} — apply to ${esc(r.company)} (a stretch on years)`,
    ),
    // Continues from do-today + stretch for the same reason: one `/draft`
    // numbering across every section it resolves against.
    ...standing.map(
      (r, i) =>
        `${cmd(`/draft ${doTodayTotal + stretchTotal + i + 1}`)} — apply to ${esc(r.company)} (older, re-confirmed open)`,
    ),
    ...askable.map((r, i) => `${cmd(`/ask ${i + 1}`)} — draft the question for ${esc(r.company)}`),
  ];

  // ONLY REAL COMMANDS APPEAR AS COMMANDS. `/draft` and `/ask` are registered on
  // the bot (gateway/telegram.ts); nothing else is. Printing a plausible-looking
  // `/jobs` would hand the founder something that silently does nothing, which is
  // a worse failure than a plain sentence — it looks like the pipeline is broken.
  if (lines.length === 0) {
    return (
      `<b>▶️ DO THIS NEXT</b>\n` +
      `Nothing is actionable today, so the useful move is upstream — just ask:\n` +
      `<i>“show me the job brief”</i> · <i>“what gaps are in my CV?”</i>`
    );
  }

  const applyInstructions =
    `\n\n<b>🚀 HOW TO APPLY (2 WAYS)</b>\n` +
    `<b>1. The Fast Way:</b> Type ${cmd(`/draft all`)} to auto-tailor CVs for all jobs above. ` +
    `Then run <code>${MAC_CLIENT_COMMAND}</code> on your Mac — it opens every queued role with ` +
    `the form already filled and waits for your click.\n` +
    `<b>2. The Manual Way:</b> Type ${cmd(`/draft <number>`)} (e.g. ${cmd(`/draft 1`)}) to get the ` +
    `tailored PDF and a direct application link. Apply in your browser, then type ` +
    `${cmd(`/applied 1`)} to clear it from the queue.`;

  return (
    `<b>▶️ DO THIS NEXT</b>\n` +
    lines.join("\n") +
    applyInstructions +
    `\n\n<i>Or just ask — “show me the job brief”, “what gaps are in my CV?”</i>`
  );
}
