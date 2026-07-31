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
import type { Liveness } from "./liveness.js";

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

function renderRow(row: BriefRow, index: number, command: string): string {
  const label = `${row.company} — ${row.title}`;
  const liveness =
    row.liveness === "live"
      ? " · verified live"
      : row.liveness === "unverifiable"
        ? " · ⚠ couldn't confirm still open"
        : "";
  const gap =
    row.overlap.missing.length > 0
      ? `\n     They ask for ${row.overlap.missing.slice(0, 3).join(", ")}; your CV doesn't say ${
          row.overlap.missing.length === 1 ? "it" : "them"
        }.`
      : "";
  return (
    `  ${index}. ${label}\n` +
    `     overlap ${formatOverlap(row.overlap)}${liveness} · ${row.route}\n` +
    `     ${row.headline}${gap}\n` +
    `     → ${command} ${index}`
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
  const date = input.date.toISOString().slice(0, 10);
  const trackSummary = Object.entries(input.perTrack)
    .filter(([, n]) => n > 0)
    .map(([track, n]) => `${track} ${n}`)
    .join(" · ");

  const head =
    `JOB BRIEF — ${date} · ${input.screened} screened` +
    (trackSummary.length > 0 ? ` · ${trackSummary}` : "");

  const sections: string[] = [];

  if (input.failures.length > 0) {
    // First, above everything. A partial run that reads like a full one is a
    // confident, wrong finding about the market.
    sections.push(
      `⚠ INCOMPLETE RUN — ${input.failures.length} source(s) failed:\n` +
        input.failures.map((f) => `  · ${f}`).join("\n") +
        `\n  Today's numbers are a floor, not a measurement.`,
    );
  }

  const doToday = selectDoToday(input.rows);
  sections.push(
    doToday.length === 0
      ? `▸ DO TODAY (0)\n  Nothing cleared every gate AND verified live today.`
      : `▸ DO TODAY (${doToday.length})\n` +
          doToday.map((r, i) => renderRow(r, i + 1, "/draft")).join("\n\n"),
  );

  const askable = selectAskable(input.rows);
  if (askable.length > 0) {
    sections.push(
      `▸ ONE QUESTION AWAY (${askable.length})\n` +
        askable.map((r, i) => renderRow(r, i + 1, "/ask")).join("\n\n"),
    );
  }

  const rejected = input.rows.filter((r) => r.verdict === "reject");
  if (rejected.length > 0) {
    const byReason = new Map<string, number>();
    for (const r of rejected) byReason.set(r.headline, (byReason.get(r.headline) ?? 0) + 1);
    sections.push(
      `▸ NOT LAWFUL (${rejected.length})   ` +
        [...byReason.entries()].map(([reason, n]) => `${reason} ×${n}`).join(" · "),
    );
  }

  const expired = input.rows.filter((r) => r.liveness === "expired");
  if (expired.length > 0) {
    // Stated, not silently removed. A row that vanishes without explanation is
    // indistinguishable from a bug in the ranking.
    sections.push(
      `▸ CLOSED SINCE WE SAW THEM (${expired.length})\n` +
        expired.map((r) => `  · ${r.company} — ${r.title}`).join("\n"),
    );
  }

  if (input.trends.length > 0) {
    sections.push(
      `▸ WHAT THE MARKET ASKED\n` +
        input.trends
          .map((t) => {
            const absence =
              t.absentDays !== null
                ? ` — missing from your ${t.track} CV for ${pluralDays(t.absentDays)}`
                : "";
            // Deliberately a COUNT, not a percentage. `seenCount` is an all-time
            // tally incremented on every passing screen; `sampleSize` counts the
            // distinct rows standing today. Dividing them printed "150%" live on
            // 2026-07-31 — a figure the stored data cannot support. The raw
            // number is the one we actually measured.
            const times = t.seenCount === 1 ? "once" : `${t.seenCount}×`;
            return `  ${t.track}  ${t.term} — asked ${times} across ${t.sampleSize} role(s) that cleared the gates${absence}`;
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
      `⚠ ${stale.length} PASS role(s) have sat undrafted for up to ${pluralDays(oldest)}.\n` +
        `  Screening is not the bottleneck. Drafting is.`,
    );
  }

  return `${head}\n\n${sections.join("\n\n")}`;
}
