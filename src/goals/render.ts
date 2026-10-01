/**
 * FounderOS — goals: the standup message (pure)
 * =============================================
 * One line per goal, numbered with the position `/goal <n>` means, every reason printed beside its own
 * result, and split into several messages rather than losing a row when it will not fit in Telegram's
 * 4,096 characters (CLAUDE.md #26). Messages are HTML; every founder-typed string goes through `esc`.
 *
 *   Standup · Wed 30 Sep
 *   1. Tashi 5 NL applications/week: 0 of 5 (need 5 more by 31 Oct, pace BEHIND)
 *   2. Dispatch loop ships 1 merged fix/week: 1 of 1 ✓ on track
 *   Blocked: none
 *
 * A goal gets a "Plan next step" button only when there is something to plan: it is behind, its pace is
 * unknown, or its metric could not be read. A button that would not fit in 64 bytes is not built.
 */

import { TELEGRAM_MAX_CHARS, esc } from "../tools/jobhunt/telegram-format.js";
import { encodeGoalCallback } from "./callbacks.js";
import type { GoalEvaluation } from "./evaluate.js";
import { formatDayLabel, formatShortDate, localDateKey, daysBetween } from "./local-date.js";
import { formatNumber } from "./numeric.js";

export interface ButtonSpec {
  readonly text: string;
  readonly callback_data: string;
}

export interface RenderedMessage {
  readonly text: string;
  /** The goals whose review row this message reports (blocked ones included): what is marked sent when it is delivered. */
  readonly goalIds: readonly string[];
  readonly keyboard: readonly (readonly ButtonSpec[])[];
}

export interface RenderOptions {
  readonly heading: "Standup" | "Goals";
  /** Today's local date key. */
  readonly today: string;
  readonly timeZone: string;
  /** `standup` announces a finished goal as marked done; `list` (the /goals view) mutates nothing, so it only says it will be. */
  readonly mode: "standup" | "list";
  /** Some goals were already delivered by an earlier run today: this message carries the rest. */
  readonly continued?: boolean;
}

/** Room kept for the header line ("<b>Standup · Wed 30 Sep (2/3)</b>") when packing rows into a message. */
const HEADER_RESERVE = 80;

/** How a due date reads next to a goal that is behind. */
function dueClause(dueOn: string | null, today: string): string {
  if (dueOn === null) return "";
  const days = daysBetween(today, dueOn);
  if (days > 0) return ` by ${formatShortDate(dueOn)}`;
  return days === 0 ? ", due today" : `, PAST DUE since ${formatShortDate(dueOn)}`;
}

export function goalLine(e: GoalEvaluation, today: string, mode: "standup" | "list" = "standup"): string {
  const { goal, number: n } = e;
  const title = esc(goal.title);
  const lead = e.unblockedNow ? "🔓 " : "";

  if (e.outcome !== null && !e.outcome.ok) return `${lead}${n}. ${title}: metric unavailable: ${esc(e.outcome.error)}`;
  const value = e.value ?? 0;
  const head = `${n}. ${title}: ${formatNumber(value)} of ${formatNumber(goal.target)}`;

  if (e.completed) {
    return mode === "standup"
      ? `✅ ${lead}${n}. ${title}: reached ${formatNumber(value)} of ${formatNumber(goal.target)} — marked done (${esc(e.evidence)})`
      : `${lead}${head} ✓ target reached (the next standup marks it done)`;
  }
  switch (e.pace) {
    case "ahead":
      return `${lead}${head} ✓ ahead`;
    case "on_track":
      return `${lead}${head} ✓ on track`;
    case "behind":
      return `${lead}${head} (need ${formatNumber(Math.max(0, goal.target - value))} more${dueClause(goal.due_on, today)}, pace BEHIND)`;
    case "unknown":
      return `${lead}${head} (pace unknown: no due date)`;
  }
}

function blockedLine(e: GoalEvaluation, timeZone: string): string {
  const reason = e.goal.blocker !== null && e.goal.blocker !== "" ? esc(e.goal.blocker) : "no reason recorded";
  const until = e.goal.blocked_until === null ? "no end date" : `until ${formatShortDate(localDateKey(e.goal.blocked_until, timeZone))}`;
  return `• ${e.number}. ${esc(e.goal.title)} — ${reason} (${until})`;
}

/** Does this goal have something worth planning? Not when it is on track, ahead, finished or blocked. */
function needsPlan(e: GoalEvaluation): boolean {
  if (e.blockedNow || e.completed) return false;
  return e.pace === "behind" || e.pace === "unknown" || (e.outcome !== null && !e.outcome.ok);
}

interface Row {
  readonly text: string;
  readonly goalId: string;
  readonly number: number;
  readonly plan: boolean;
}

/** Render the goals into one or more messages. No goals means no message: an empty standup is never sent. */
export function renderStandup(evals: readonly GoalEvaluation[], opts: RenderOptions): RenderedMessage[] {
  if (evals.length === 0) return [];
  const ordered = [...evals].sort((a, b) => a.number - b.number);
  const active = ordered.filter((e) => !e.blockedNow);
  const blocked = ordered.filter((e) => e.blockedNow);

  const rows: Row[] = active.map((e) => ({ text: goalLine(e, opts.today, opts.mode), goalId: e.goal.id, number: e.number, plan: needsPlan(e) }));
  if (blocked.length === 0) rows.push({ text: "Blocked: none", goalId: "", number: 0, plan: false });
  blocked.forEach((e, i) => {
    const line = blockedLine(e, opts.timeZone);
    rows.push({ text: i === 0 ? `Blocked:\n${line}` : line, goalId: e.goal.id, number: e.number, plan: false });
  });

  const budget = TELEGRAM_MAX_CHARS - HEADER_RESERVE;
  const chunks: Row[][] = [[]];
  let used = 0;
  for (const row of rows) {
    const cost = row.text.length + 1;
    const current = chunks[chunks.length - 1]!;
    if (used + cost > budget && current.length > 0) {
      chunks.push([row]);
      used = cost;
    } else {
      current.push(row);
      used += cost;
    }
  }

  const label = formatDayLabel(opts.today);
  return chunks.map((chunk, i) => {
    const suffix = chunks.length > 1 ? ` (${i + 1}/${chunks.length})` : opts.continued ? " (continued)" : "";
    const goalIds = chunk.filter((r) => r.goalId !== "").map((r) => r.goalId);
    const keyboard = chunk
      .filter((r) => r.plan)
      .flatMap((r) => {
        const data = encodeGoalCallback({ kind: "plan", goalId: r.goalId });
        return data === null ? [] : [[{ text: `Plan next step · ${r.number}`, callback_data: data }]];
      });
    return { text: [`<b>${opts.heading} · ${label}${suffix}</b>`, ...chunk.map((r) => r.text)].join("\n"), goalIds, keyboard };
  });
}
