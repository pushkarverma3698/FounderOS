/**
 * FounderOS — the first five lines of the brief
 * =============================================
 * Split out of brief.ts on 2026-09-08, when the A2/A3 truth fixes pushed that
 * file past its 400-line CI budget (`scripts/verify-architecture.ts`,
 * loc-budget). Same precedent as brief-sections.ts, brief-select.ts and
 * brief-actions.ts before it, and re-exported from brief.ts so every import
 * site keeps resolving there.
 *
 * These lines matter more than their length suggests: they are the only ones
 * guaranteed to be read, and every defect the 2026-09-08 truth audit found was
 * in them. Three rules, each one a fix for something this header actually said:
 *
 *   1. LEAD WITH THE DECISION COUNT, not the machine's. "47 screened" is a
 *      statement about the pipeline; "3 to apply to today" is a statement about
 *      the founder's next hour.
 *   2. EVERY NUMBER NAMES WHAT IT COUNTS. The queue size was printed twice, once
 *      as "100 screened" and once as "100 fresh roles in the queue" — the same
 *      figure under two nouns, neither of which was "the number of postings we
 *      screened".
 *   3. NEVER PROMISE COMPLETENESS ON A RUN THAT CUT SOMETHING. The line "Nothing
 *      is cut — read to the end" was printed verbatim above a brief that had
 *      silently dropped 66 of 166 qualifying rows.
 *
 * Pure formatting. No DB, no clock of its own.
 */

import { esc } from "./telegram-format.js";

/** How many rows each actionable section HAS, before any cap is applied. */
export interface SectionTotals {
  readonly doToday: number;
  readonly stretch: number;
  readonly askable: number;
  readonly standing: number;
}

/** Everything the header prints, and nothing else — so it is testable alone. */
export interface HeaderInput {
  readonly date: Date;
  readonly rowsLoaded: number;
  readonly perTrack: Readonly<Record<string, number>>;
  /**
   * Postings that actually reached `screenPosting` on the run that produced
   * this brief. Undefined on a typed `/jobs`, which ran no sweep — see the
   * module header for why that prints nothing rather than a substitute.
   */
  readonly screened?: number | undefined;
  /** Rows qualifying inside the window, UNCAPPED. Undefined when the count query failed. */
  readonly queued?: number | undefined;
  readonly agedOut?: number | undefined;
  /** The window in hours, or null when the read carried no age limit. */
  readonly maxAgeHours?: number | null | undefined;
  /**
   * What this list is, in words: "posted in the last 24h", "everything on file",
   * "found since 16:30".
   *
   * UX rule 2 of the fresh-first plan, and it earns its line: with three verbs
   * over one queue, a list that does not name its own scope leaves an empty
   * market and a narrow window looking identical. Falls back to the hour window
   * when no verb set one.
   */
  readonly scopeLabel?: string | undefined;
}

/** "1 role" / "3 roles". "role(s)" is the tell of a template that never learned to count. */
export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Whether this brief left qualifying rows unloaded.
 *
 * `queued` is fail-open (see BriefInput): an unmeasured total must read as "no
 * cut", never as a cut of unknown size. Guarding on `> rowsLoaded` rather than
 * on a limit constant keeps that true without this file knowing what the limit
 * is.
 */
export function wasCut(input: HeaderInput): boolean {
  return input.queued !== undefined && input.queued > input.rowsLoaded;
}

export function renderHeader(input: HeaderInput, totals: SectionTotals): string {
  const date = input.date.toISOString().slice(0, 10);
  const trackSummary = Object.entries(input.perTrack)
    .filter(([, n]) => n > 0)
    .map(([track, n]) => `${esc(track)} ${n}`)
    .join(" · ");

  // The stretch/standing/askable counts are here for the same reason those
  // sections exist: a header reading "Nothing actionable today" above roles
  // the founder can apply to right now denies the message printed underneath
  // it, which is the same class of defect as hiding those rows. Named
  // `secondaryCounts`, not `standing` — that word already means something
  // different in brief.ts (the STILL OPEN, OLDER section's rows).
  const secondaryCounts = [
    totals.stretch > 0 ? `${totals.stretch} worth a stretch` : "",
    totals.standing > 0 ? `${totals.standing} still open, older` : "",
    totals.askable > 0 ? `${totals.askable} one question away` : "",
  ].filter((part) => part.length > 0);

  const counts =
    totals.doToday > 0
      ? [`<b>${totals.doToday} to apply to today</b>`, ...secondaryCounts].join(" · ")
      : secondaryCounts.length > 0
        ? [`<b>0 ready to send</b>`, ...secondaryCounts].join(" · ")
        : `<b>Nothing actionable today</b>`;

  return [
    `<b>🎯 JOB BRIEF</b> · ${date}`,
    counts,
    queueLine(input),
    trackSummary.length > 0 ? `<i>${trackSummary}</i>` : "",
    screenedLine(input.screened),
    completenessLine(input),
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

/**
 * How many roles are in the queue, how old that window is, and what fell out.
 *
 * Printed even at 0/0 — an empty queue must read as "no fresh jobs right now",
 * never be silently indistinguishable from a broken sweep. That ambiguity is
 * what erased the previous screening log's credibility.
 *
 * "in your queue", not "screened": this is the population the founder can act
 * on, and calling it by the machine's word for an upstream stage is A3.
 */
function queueLine(input: HeaderInput): string {
  const agedOut = input.agedOut ?? 0;
  // "&lt;", not "<". A bare "<" followed by a space is an empty start tag to
  // Telegram, which rejects the WHOLE message rather than the character — this
  // line alone took /jobs down on 2026-08-21. See escapeStrayAngles().
  const scope =
    input.scopeLabel ??
    (input.maxAgeHours === null
      ? "everything on file"
      : `&lt; ${input.maxAgeHours ?? 24}h old`);
  // The aged-out count is meaningless under an unbounded read — nothing aged
  // out of a window there is none of — so it is omitted rather than printed as
  // a confident 0.
  const excluded =
    input.maxAgeHours === null && input.scopeLabel === undefined
      ? ""
      : ` · ${plural(agedOut, "older role", "older roles")} aged out`;
  return `<i>${plural(input.rowsLoaded, "role", "roles")} in your queue (${scope})${excluded}</i>`;
}

/** The real screening count, or silence. Never the queue size wearing its name. */
function screenedLine(screened: number | undefined): string {
  if (screened === undefined) return "";
  return `<i>${screened.toLocaleString("en-US")} ${screened === 1 ? "posting" : "postings"} reached screening in the last sweep</i>`;
}

/**
 * The completeness claim — and its opposite when the load bound bit.
 *
 * These two are mutually exclusive by construction rather than by two separate
 * conditions that could both be true. A brief that cuts rows AND says nothing
 * was cut is worse than either alone: the founder believes the claim and stops
 * looking for the missing rows, which is exactly what happened to 66 of them.
 */
function completenessLine(input: HeaderInput): string {
  if (wasCut(input)) {
    const cut = (input.queued ?? 0) - input.rowsLoaded;
    return (
      `<i>⚠ Showing the newest ${input.rowsLoaded} of ${input.queued} in the window — ` +
      `${plural(cut, "role is", "roles are")} not in this message. ` +
      `Send /csv for the whole queue.</i>`
    );
  }
  // No part count promised. The number of parts depends on how many roles are
  // standing, and the header is rendered before the split knows — a stated
  // "2–3" was wrong the first time it met the real table (6 parts, 53 rows).
  return `<i>This brief spans several messages. Nothing is cut — read to the end.</i>`;
}
