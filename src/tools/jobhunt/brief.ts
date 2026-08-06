/**
 * FounderOS — the daily job brief
 * ===============================
 * What replaces the screening log.
 *
 * The log answered "is this lawful?" and stopped. On 2026-07-31 it reported 17
 * verdicts, 13 of which needed founder attention, in no order — and if the
 * founder ignored it entirely, nothing noticed. Weeks of flawless screening had
 * produced zero applications, because screening was never the binding constraint.
 *
 * Four properties make this an outcome rather than a report:
 *
 *   1. RANKED, best first. An undifferentiated queue is a list; an ordered one
 *      is a decision.
 *   2. COMPLETE. Every row shows every check with its own result (brief-row.ts).
 *      The first production brief showed ONE line per row, picked by position
 *      rather than by status, and the founder could not tell why any company was
 *      on the list. Telegram's 4,096-character limit is handled by SPLITTING the
 *      message, never by hiding a row — `splitForTelegram` exists for that.
 *   3. ONE COMMAND PER ROW. `/draft 1` produces the application. Still
 *      HITL-gated, never auto-sent (ADR-009).
 *   4. IT REMEMBERS, and it prices itself. "absent from your CV for 14 days",
 *      "6 roles undrafted for 5 days", "$0.24 spent today". Ignoring the brief
 *      was silent; making it loud is the whole point.
 *
 * Pure formatting. Every input is passed in, so the entire brief is unit-testable
 * with no DB, no network and no model.
 */

import { cmd, esc } from "./telegram-format.js";
import { renderLegend, type BriefRow } from "./brief-row.js";
import {
  isTooSenior,
  renderFilterNotes,
  renderMarketBlocks,
  renderRejectLine,
  renderSpend,
  renderTrends,
  type SpendLine,
  type TrendRow,
} from "./brief-sections.js";
import {
  isAskableRow,
  isDoTodayRow,
  isStretchRow,
  selectAskable,
  selectDoToday,
  selectStretch,
} from "./brief-select.js";

// Re-exported so the transport keeps one import site for the escape helper.
export { toTelegramSafe, splitForTelegram, TELEGRAM_MAX_CHARS } from "./telegram-format.js";
export { renderRow, renderLegend } from "./brief-row.js";
export type { BriefRow } from "./brief-row.js";
// The reject-line, trends and spend renderers moved to brief-sections.ts on
// 2026-08-01 when this file crossed its size budget. Re-exported so every
// existing import site — and every test — keeps resolving here.
export { isTooSenior } from "./brief-sections.js";
export type { TrendRow, SpendLine } from "./brief-sections.js";
// Section membership and the caps moved to brief-select.ts on 2026-08-06, when a
// third actionable section pushed this file against the 400-line budget. Same
// precedent as brief-sections.ts: re-exported so every import site and every
// test keeps resolving here.
export {
  isAskableRow,
  isDoTodayRow,
  isStretchRow,
  selectAskable,
  selectDoToday,
  selectStretch,
  ASK_CAP,
  DO_TODAY_CAP,
  STRETCH_CAP,
} from "./brief-select.js";

/** A horizontal rule. Telegram has no <hr>, and a run of box characters reads as one. */
const RULE = "━━━━━━━━━━━━━━━━━━━━━";

/**
 * How many rejected rows are NAMED. The rest are counted.
 *
 * Every reject is stored in `job_applications` regardless — that is the founder's
 * instruction and it is a property of the database, not of this message. What the
 * brief owes him is enough of the list to audit the filter ("is it throwing away
 * things it shouldn't?") without the audit trail outweighing the ten roles he can
 * actually act on.
 */
export const REJECT_CAP = 10;

/** Below this many days undrafted, the nag would be noise rather than a signal. */
export const STALE_UNDRAFTED_DAYS = 3;

export interface BriefInput {
  readonly date: Date;
  readonly screened: number;
  readonly perTrack: Readonly<Record<string, number>>;
  readonly rows: readonly BriefRow[];
  readonly trends: readonly TrendRow[];
  /** Pools that failed this run — an outage must read as an outage, never as an empty market. */
  readonly failures: readonly string[];
  /** Rows the feeds filtered on purpose. Separate from failures: this is a working day. */
  readonly notes?: readonly string[];
  /** Today's feed spend. Omitted when the ledger is unavailable, never faked. */
  readonly spend?: SpendLine;
}

function pluralDays(n: number): string {
  return n === 1 ? "1 day" : `${n} days`;
}

/** "1 role" / "3 roles". "role(s)" is the tell of a template that never learned to count. */
function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** How many rows each actionable section HAS, before any cap is applied. */
interface SectionTotals {
  readonly doToday: number;
  readonly stretch: number;
  readonly askable: number;
}

/** "…and 7 more" — stated with the number, never a silent cut. */
function overflowNote(total: number, shown: number, what: string): string {
  if (total <= shown) return "";
  return `\n\n<i>+ ${total - shown} more ${what} not shown here. Ask for the job brief again after clearing these.</i>`;
}

/**
 * The closing block: every command the founder can run right now, spelled out.
 *
 * The brief's whole purpose is to end in an action, and "▸ /draft 1" buried
 * beside row one is easy to scroll past. Collecting the commands at the bottom —
 * where reading stops — with the company each one targets means the last thing
 * on screen is a list of things to do, not a summary of things that happened.
 */
function renderNextActions(
  doToday: readonly BriefRow[],
  stretch: readonly BriefRow[],
  askable: readonly BriefRow[],
): string {
  const lines = [
    ...doToday.map((r, i) => `${cmd(`/draft ${i + 1}`)} — apply to ${esc(r.company)}`),
    // Numbered as a CONTINUATION of do-today, because `/draft` resolves across
    // both sections as one run. Restarting at 1 would make `/draft 1` ambiguous.
    ...stretch.map(
      (r, i) =>
        `${cmd(`/draft ${doToday.length + i + 1}`)} — apply to ${esc(r.company)} (a stretch on years)`,
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

  return (
    `<b>▶️ DO THIS NEXT</b>\n` +
    lines.join("\n") +
    `\n<i>Or just ask — “show me the job brief”, “what gaps are in my CV?”</i>`
  );
}

/**
 * Render the brief.
 *
 * A run that produced nothing actionable says so in those words and states what
 * WAS screened. "0 postings" and "17 postings, none actionable" are entirely
 * different findings, and collapsing them is how a broken feed hides for a week.
 */
export function formatDailyBrief(input: BriefInput): string {
  const doToday = selectDoToday(input.rows);
  const stretch = selectStretch(input.rows);
  const askable = selectAskable(input.rows);

  // ONE RULE FOR EVERY NUMBER IN THIS MESSAGE: a count is the true UNCAPPED
  // population, and the cap only ever appears as an explicit "+ N more not
  // shown". The reject sections have always worked that way; ASK did not, and
  // when the 2026-08-06 Experience change started routing rescued rows there,
  // the fifth one was printed nowhere and counted nowhere — under a header that
  // says verbatim "Nothing is cut — read to the end". As a REJECT that same row
  // had been counted and named. The change made its own rescues less visible.
  const totals: SectionTotals = {
    doToday: input.rows.filter(isDoTodayRow).length,
    stretch: input.rows.filter(isStretchRow).length,
    askable: input.rows.filter(isAskableRow).length,
  };

  const sections: string[] = [renderHeader(input, totals)];

  if (input.failures.length > 0) {
    // Above everything actionable. A partial run that reads like a full one is a
    // confident, wrong finding about the market — and the founder would act on
    // it, or stop acting, for the wrong reason.
    sections.push(
      `<b>⚠️ INCOMPLETE RUN</b> — ${input.failures.length} source(s) failed\n` +
        input.failures.map((f) => `• ${esc(f)}`).join("\n") +
        `\n<i>Today's numbers are a floor, not a measurement.</i>`,
    );
  }

  sections.push(
    doToday.length === 0
      ? `<b>✅ APPLY TODAY (0)</b>\nNothing cleared every check <i>and</i> verified still open.`
      : `<b>✅ APPLY TODAY (${totals.doToday})</b>\n` +
          `<i>Every check below cleared. The only thing left is writing it.</i>\n\n` +
          renderMarketBlocks(doToday, "/draft") +
          overflowNote(totals.doToday, doToday.length, "ready to apply to"),
  );

  // Between APPLY TODAY and ONE QUESTION AWAY, and carrying `/draft` rather than
  // `/ask`: the years bar is not a question for the employer. Asking whether
  // "5+ years" is firm invites a pre-emptive rejection on the one gate that is
  // written as a wish (experience.ts, 2026-08-06). These rows need an
  // application, and their numbering continues DO TODAY's for that reason.
  if (stretch.length > 0) {
    sections.push(
      `<b>🪜 A STRETCH WORTH APPLYING TO (${totals.stretch})</b>\n` +
        `<i>Every check cleared except the years — they ask for more than your ~3.5 ` +
        `shipped. That is a wish, not a wall, and applying early is what makes it ` +
        `land. Nothing here needs a question first.</i>\n\n` +
        renderMarketBlocks(stretch, "/draft", doToday.length + 1) +
        overflowNote(totals.stretch, stretch.length, "stretch roles"),
    );
  }

  if (askable.length > 0) {
    sections.push(
      `<b>❓ ONE QUESTION AWAY (${totals.askable})</b>\n` +
        `<i>Each has exactly one check we could not settle from the ad. ` +
        `Asking the employer settles it.</i>\n\n` +
        renderMarketBlocks(askable, "/ask") +
        overflowNote(totals.askable, askable.length, "roles one question away"),
    );
  }

  const rejected = input.rows.filter((r) => r.verdict === "reject");
  const tooSenior = rejected.filter(isTooSenior);
  const unlawful = rejected.filter((r) => !isTooSenior(r));

  // Split, because they are different findings and the founder acts on them
  // differently. "Not lawful" is a fact about the permit system; "too senior" is
  // a fact about this posting, and a run full of them means the search terms are
  // aimed above his level.
  if (tooSenior.length > 0) {
    sections.push(
      `<b>🚫 TOO SENIOR / TOO JUNIOR (${tooSenior.length})</b>\n` +
        `<i>Kept on record, not applied to. Every one names the years it asked for.</i>\n` +
        tooSenior.slice(0, REJECT_CAP).map(renderRejectLine).join("\n") +
        overflowNote(tooSenior.length, Math.min(tooSenior.length, REJECT_CAP), "level-barred roles"),
    );
  }

  if (unlawful.length > 0) {
    sections.push(
      `<b>⛔ NOT LAWFUL (${unlawful.length})</b>\n` +
        `<i>A legal bar, not a preference. Nothing you write changes these.</i>\n` +
        unlawful.slice(0, REJECT_CAP).map(renderRejectLine).join("\n") +
        overflowNote(unlawful.length, Math.min(unlawful.length, REJECT_CAP), "barred roles"),
    );
  }

  const expired = input.rows.filter((r) => r.liveness === "expired");
  if (expired.length > 0) {
    // Stated, not silently removed. A row that vanishes without explanation is
    // indistinguishable from a bug in the ranking.
    sections.push(
      `<b>🚪 CLOSED SINCE WE SAW THEM (${expired.length})</b>\n` +
        expired.map((r) => `• ${esc(r.company)} — ${esc(r.title)}`).join("\n"),
    );
  }

  if (input.trends.length > 0) sections.push(renderTrends(input.trends));

  const stale = input.rows.filter((r) => r.verdict === "pass" && r.ageDays >= STALE_UNDRAFTED_DAYS);
  if (stale.length > 0) {
    const oldest = Math.max(...stale.map((r) => r.ageDays));
    // The line that makes ignoring the brief cost something. Without it, a
    // pipeline that produces nothing looks exactly like one that is working.
    sections.push(
      `<b>⚠️ ${plural(stale.length, "role has", "roles have")} sat undrafted for up to ` +
        `${pluralDays(oldest)}.</b>\n` +
        `<i>Screening is not the bottleneck. Drafting is.</i>`,
    );
  }

  const filtered = renderFilterNotes(input.notes ?? []);
  if (filtered.length > 0) sections.push(filtered);

  if (input.spend) sections.push(renderSpend(input.spend));

  const legend = renderLegend(input.rows);
  if (legend.length > 0) sections.push(legend);

  sections.push(renderNextActions(doToday, stretch, askable));

  return sections.join(`\n\n${RULE}\n\n`);
}

/**
 * The first three lines, which are the only ones guaranteed to be read.
 *
 * They lead with the DECISION COUNT rather than the screening count. "47
 * screened" is a statement about the machine; "3 to apply to today" is a
 * statement about the founder's next hour, and it is the number that determines
 * whether the rest of the message gets opened at all.
 */
function renderHeader(input: BriefInput, totals: SectionTotals): string {
  const date = input.date.toISOString().slice(0, 10);
  const trackSummary = Object.entries(input.perTrack)
    .filter(([, n]) => n > 0)
    .map(([track, n]) => `${esc(track)} ${n}`)
    .join(" · ");

  // The stretch count is here for the same reason the section exists: a header
  // reading "Nothing actionable today" above three roles the founder can apply
  // to right now denies the message printed underneath it, which is the same
  // class of defect as hiding those rows.
  const standing = [
    totals.stretch > 0 ? `${totals.stretch} worth a stretch` : "",
    totals.askable > 0 ? `${totals.askable} one question away` : "",
  ].filter((part) => part.length > 0);

  const counts =
    totals.doToday > 0
      ? [`<b>${totals.doToday} to apply to today</b>`, ...standing].join(" · ")
      : standing.length > 0
        ? [`<b>0 ready to send</b>`, ...standing].join(" · ")
        : `<b>Nothing actionable today</b>`;

  return (
    `<b>🎯 JOB BRIEF</b> · ${date}\n` +
    `${counts}\n` +
    `<i>${input.screened} screened${trackSummary.length > 0 ? ` · ${trackSummary}` : ""}</i>\n` +
    // No number promised. The part count depends on how many roles are standing,
    // and the header is rendered before the split knows — a stated "2–3" was
    // wrong the first time it met the real table (6 parts, 53 rows).
    `<i>This brief spans several messages. Nothing is cut — read to the end.</i>`
  );
}

// `toTelegramSafe` now lives in telegram-format.ts and is re-exported at the top
// of this file. It moved because the brief became markup-bearing: escaping the
// whole rendered message would print "&lt;b&gt;" instead of bolding anything.
// Escaping is now applied per VALUE, at each interpolation site above.
