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
 * Three properties make this an outcome rather than a report:
 *
 *   1. RANKED, and capped at what a person can act on before work. An
 *      undifferentiated queue of 13 is a list; three roles in order is a decision.
 *   2. ONE COMMAND PER ROW. `/draft 1` produces the application. Still
 *      HITL-gated, never auto-sent (ADR-009).
 *   3. IT REMEMBERS. "absent from your CV for 14 days", "6 roles undrafted for 5
 *      days". Ignoring the brief is currently silent; making it loud is the whole
 *      point, and it is the same failure-direction argument that turned rejects
 *      into flags in PR #393.
 *
 * Pure formatting. Every input is passed in, so the entire brief is unit-testable
 * with no DB, no network and no model.
 */

import { formatOverlap, type OverlapResult } from "./overlap.js";
import { cmd, esc, link } from "./telegram-format.js";
import type { Liveness } from "./liveness.js";

// Re-exported so the transport keeps one import site for the escape helper.
export { toTelegramSafe, splitForTelegram, TELEGRAM_MAX_CHARS } from "./telegram-format.js";

/** A horizontal rule. Telegram has no <hr>, and a run of box characters reads as one. */
const RULE = "━━━━━━━━━━━━━━━━━━━━━";

/** More than this in front of a person before work is a list again, not a decision. */
export const DO_TODAY_CAP = 3;
export const ASK_CAP = 3;

/** Below this many days undrafted, the nag would be noise rather than a signal. */
export const STALE_UNDRAFTED_DAYS = 3;

export interface BriefRow {
  readonly id: string;
  readonly company: string;
  readonly title: string;
  readonly track: string;
  readonly verdict: string;
  readonly route: string;
  readonly url: string | null;
  readonly overlap: OverlapResult;
  readonly liveness: Liveness;
  /** The single most decision-relevant gate line. */
  readonly headline: string;
  /** Days since it was screened and left untouched. */
  readonly ageDays: number;
}

export interface TrendRow {
  readonly track: string;
  readonly sampleSize: number;
  readonly term: string;
  readonly seenCount: number;
  /** Days this term has been in demand and absent from that track's CV. */
  readonly absentDays: number | null;
}

export interface BriefInput {
  readonly date: Date;
  readonly screened: number;
  readonly perTrack: Readonly<Record<string, number>>;
  readonly rows: readonly BriefRow[];
  readonly trends: readonly TrendRow[];
  /** Pools that failed this run — an outage must read as an outage, never as an empty market. */
  readonly failures: readonly string[];
}

function pluralDays(n: number): string {
  return n === 1 ? "1 day" : `${n} days`;
}

/** "1 role" / "3 roles". "role(s)" is the tell of a template that never learned to count. */
function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * DO TODAY: passed every gate AND confirmed still open.
 *
 * `unverifiable` does not qualify — but it does not disqualify the row from the
 * brief either; it lands in the ASK section with the reason stated. Silently
 * dropping a role because a network call failed is the failure direction this
 * pipeline exists to avoid.
 */
export function selectDoToday(rows: readonly BriefRow[]): BriefRow[] {
  return rows
    .filter((r) => r.verdict === "pass" && r.liveness === "live")
    .slice(0, DO_TODAY_CAP);
}

/**
 * ONE QUESTION AWAY: a single unresolved gate stands between this and an
 * application, and the founder can settle it by asking the employer.
 */
export function selectAskable(rows: readonly BriefRow[]): BriefRow[] {
  return rows
    .filter((r) => r.verdict === "flag" && r.liveness !== "expired")
    .slice(0, ASK_CAP);
}

/**
 * One row, laid out so the decision is readable in about three seconds.
 *
 * The order is deliberate and it is the order a person actually decides in:
 * WHO the role is with, HOW WELL it fits, WHETHER it is still open, WHAT the one
 * open question is, WHAT is missing from the CV, and finally the command that
 * acts on it. The command is last because it is what the eye should stop on.
 *
 * The title carries the link, so opening the posting is one tap and does not
 * need a separate URL line competing for attention.
 */
function renderRow(row: BriefRow, index: number, command: string): string {
  const heading = `<b>${index}. ${esc(row.company)}</b> — ${link(row.title, row.url)}`;

  const liveness =
    row.liveness === "live"
      ? "✓ still open"
      : row.liveness === "unverifiable"
        ? "⚠ couldn't confirm it's still open"
        : "✕ closed";

  const facts = `<i>${esc(formatOverlap(row.overlap))} skills · ${liveness} · ${esc(row.route)}</i>`;

  const gap =
    row.overlap.missing.length > 0
      ? `\n    <i>Not on your CV:</i> ${esc(row.overlap.missing.slice(0, 3).join(", "))}`
      : "";

  return (
    `${heading}\n` +
    `    ${facts}\n` +
    `    ${esc(row.headline)}${gap}\n` +
    `    ▸ ${cmd(`${command} ${index}`)}`
  );
}

/**
 * The closing block: every command the founder can run right now, spelled out.
 *
 * The brief's whole purpose is to end in an action, and "→ /draft 1" buried
 * beside row one is easy to scroll past. Collecting the commands at the bottom —
 * where reading stops — with the company each one targets means the last thing
 * on screen is a list of things to do, not a summary of things that happened.
 */
function renderNextActions(doToday: readonly BriefRow[], askable: readonly BriefRow[]): string {
  const lines = [
    ...doToday.map((r, i) => `${cmd(`/draft ${i + 1}`)} — apply to ${esc(r.company)}`),
    ...askable.map((r, i) => `${cmd(`/ask ${i + 1}`)} — draft the question for ${esc(r.company)}`),
  ];

  // ONLY REAL COMMANDS APPEAR AS COMMANDS. `/draft` and `/ask` are registered on
  // the bot (gateway/telegram.ts); nothing else is. Printing a plausible-looking
  // `/jobs` would hand the founder something that silently does nothing, which is
  // a worse failure than a plain sentence — it looks like the pipeline is broken.
  // Everything else is phrased as the plain English the planner already routes.
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
  const askable = selectAskable(input.rows);

  const sections: string[] = [renderHeader(input, doToday.length, askable.length)];

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
      ? `<b>✅ APPLY TODAY (0)</b>\nNothing cleared every gate <i>and</i> verified still open.`
      : `<b>✅ APPLY TODAY (${doToday.length})</b>\n\n` +
          doToday.map((r, i) => renderRow(r, i + 1, "/draft")).join("\n\n"),
  );

  if (askable.length > 0) {
    sections.push(
      `<b>❓ ONE QUESTION AWAY (${askable.length})</b>\n` +
        `<i>One unresolved gate each — you can settle it by asking the employer.</i>\n\n` +
        askable.map((r, i) => renderRow(r, i + 1, "/ask")).join("\n\n"),
    );
  }

  const rejected = input.rows.filter((r) => r.verdict === "reject");
  if (rejected.length > 0) {
    const byReason = new Map<string, number>();
    for (const r of rejected) byReason.set(r.headline, (byReason.get(r.headline) ?? 0) + 1);
    sections.push(
      `<b>⛔ NOT LAWFUL (${rejected.length})</b>\n` +
        [...byReason.entries()]
          .map(([reason, n]) => `• ${esc(reason)}${n > 1 ? ` <b>×${n}</b>` : ""}`)
          .join("\n"),
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

  if (input.trends.length > 0) {
    sections.push(
      `<b>📈 WHAT THE MARKET ASKED</b>\n` +
        input.trends
          .map((t) => {
            const absence =
              t.absentDays !== null
                ? ` — missing from your ${esc(t.track)} CV for ${pluralDays(t.absentDays)}`
                : "";
            // Deliberately a COUNT, not a percentage. `seenCount` is an all-time
            // tally incremented on every passing screen; `sampleSize` counts the
            // distinct rows standing today. Dividing them printed "150%" live on
            // 2026-07-31 — a figure the stored data cannot support. The raw
            // number is the one we actually measured.
            const times = t.seenCount === 1 ? "once" : `${t.seenCount}×`;
            return (
              `• <b>${esc(t.term)}</b> <i>(${esc(t.track)})</i> — asked ${times} ` +
              `across ${plural(t.sampleSize, "role", "roles")} that cleared the gates${absence}`
            );
          })
          .join("\n"),
    );
  }

  const stale = input.rows.filter(
    (r) => r.verdict === "pass" && r.ageDays >= STALE_UNDRAFTED_DAYS,
  );
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

  sections.push(renderNextActions(doToday, askable));

  return sections.join(`\n\n${RULE}\n\n`);
}

/**
 * The first three lines, which are the only ones guaranteed to be read.
 *
 * They lead with the DECISION COUNT rather than the screening count. "47
 * screened" is a statement about the machine; "3 to apply to today" is a
 * statement about the founder's next hour, and it is the number that determines
 * whether the rest of the message gets opened at all. The screening totals stay,
 * one line down, because a day where 47 were screened and 0 passed is a very
 * different finding from a day where 2 were screened.
 */
function renderHeader(input: BriefInput, doToday: number, askable: number): string {
  const date = input.date.toISOString().slice(0, 10);
  const trackSummary = Object.entries(input.perTrack)
    .filter(([, n]) => n > 0)
    .map(([track, n]) => `${esc(track)} ${n}`)
    .join(" · ");

  const verdict =
    doToday > 0
      ? `<b>${doToday} to apply to today</b>`
      : askable > 0
        ? `<b>0 ready to send</b> · ${askable} one question away`
        : `<b>Nothing actionable today</b>`;

  const counts =
    doToday > 0 && askable > 0 ? `${verdict} · ${askable} one question away` : verdict;

  return (
    `<b>🎯 JOB BRIEF</b> · ${date}\n` +
    `${counts}\n` +
    `<i>${input.screened} screened${trackSummary.length > 0 ? ` · ${trackSummary}` : ""}</i>`
  );
}

// `toTelegramSafe` now lives in telegram-format.ts and is re-exported at the top
// of this file. It moved because the brief became markup-bearing: escaping the
// whole rendered message would print "&lt;b&gt;" instead of bolding anything.
// Escaping is now applied per VALUE, at each interpolation site above.
