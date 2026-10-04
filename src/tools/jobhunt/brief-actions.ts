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
 * The exact command that runs the Mac apply client. No longer printed in the
 * brief or the `/draft` packet (a shell command is unusable on a phone); kept
 * as the one declared copy for anything that documents the Mac lane.
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
 * section that does not begin at 1. `command` is the section's own verb (`/ask`
 * numbers its own section) with the profile word already in it; null for the
 * reject sections, whose rows no command resolves.
 */
export function overflowNote(
  total: number,
  shown: number,
  what: string,
  startAt = 1,
  command: string | null = "/draft",
): string {
  if (total <= shown) return "";
  const firstHidden = startAt + shown;
  const lastHidden = startAt + total - 1;
  const range = firstHidden === lastHidden ? `${firstHidden}` : `${firstHidden}–${lastHidden}`;
  const act = command ? `<code>${command} ${firstHidden}</code> works on any of them; ` : "";
  return `\n\n<i>+ ${total - shown} more ${what} — they are rows ${range}. ${act}<code>/csv</code> lists them all.</i>`;
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
  profileSelector = "",
): string {
  const sel = profileSelector ? `${profileSelector} ` : "";
  const lines = [
    ...doToday.map((r, i) => `${cmd(`/draft ${sel}${i + 1}`)} — apply to ${esc(r.company)}`),
    // Numbered as a CONTINUATION of do-today, because `/draft` resolves across
    // both sections as one run. Restarting at 1 would make `/draft 1` ambiguous.
    ...stretch.map(
      (r, i) =>
        `${cmd(`/draft ${sel}${doTodayTotal + i + 1}`)} — apply to ${esc(r.company)} (a stretch on years)`,
    ),
    // Continues from do-today + stretch for the same reason: one `/draft`
    // numbering across every section it resolves against.
    ...standing.map(
      (r, i) =>
        `${cmd(`/draft ${sel}${doTodayTotal + stretchTotal + i + 1}`)} — apply to ${esc(r.company)} (older, re-confirmed open)`,
    ),
    ...askable.map((r, i) => `${cmd(`/ask ${sel}${i + 1}`)} — draft the question for ${esc(r.company)}`),
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

  // No shell command and no typed /applied: the 📝 Draft buttons under the brief
  // tailor the CV, and the ✅ I applied button under the CV closes the row. Both
  // work from a phone. The Mac client still exists; it is just not the apply path.
  const applyInstructions =
    `\n\n<b>🚀 HOW TO APPLY</b>\n` +
    `Tap <b>📝 Draft</b> under this message. You get the tailored CV and the form link; ` +
    `after you apply, tap <b>✅ I applied</b>. Or type ${cmd(`/draft ${sel}<number>`)}.`;

  return (
    `<b>▶️ DO THIS NEXT</b>\n` +
    lines.join("\n") +
    applyInstructions +
    `\n\n<i>Or just ask — “show me the job brief”, “what gaps are in my CV?”</i>`
  );
}
