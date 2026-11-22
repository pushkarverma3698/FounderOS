/**
 * Daily apply scoreboard (pure)
 * =============================
 * Rows in, one struct out, then one formatter. The DB reads live in src/db/apply-scoreboard-queries.ts.
 * Funnel for one profile and one day: caught -> routed within 2h -> filled -> sent -> confirmed, plus founder
 * clicks, failures with their reasons, and what still waits by lane. Senders that write no data yet (Mac worker,
 * Claude-filled) are left out rather than shown as a made-up 0.
 */

import { esc } from "./telegram-format.js";

export const TARGET_LINE = "target 35–40 sent/day";
export const ROUTE_WITHIN_MS = 2 * 60 * 60 * 1000;
export const SCOREBOARD_MESSAGE_MAX_CHARS = 3500;
const MAX_REASON_CHARS = 80;

export interface CaughtRow {
  readonly created_at: Date | null;
  readonly apply_lane: string | null;
  readonly apply_lane_at: Date | null;
}

export type SubmitVia = "telegram" | "miniapp" | "auto" | "by-hand" | string;

export interface ScoreboardInput {
  /** Rows first seen today. */
  readonly caught: readonly CaughtRow[];
  /** Lane of every open row still waiting on a person. */
  readonly waitingLanes: readonly (string | null)[];
  /** Auto-send attempt rows written today (the click happened or was about to). */
  readonly attempts: number;
  /** job_application_submitted rows today (written only on a confirmed send), with how it was sent. */
  readonly submitted: readonly { readonly via: SubmitVia | null }[];
  /** job_auto_send_result rows today. */
  readonly results: readonly { readonly result: string; readonly detail: string }[];
}

export interface Scoreboard {
  readonly caught: number;
  readonly routedWithin2h: number;
  readonly filled: number;
  readonly sent: number;
  readonly sentBy: { readonly vps: number; readonly afterClick: number; readonly byHand: number };
  readonly confirmed: number;
  readonly clicks: number;
  readonly failed: readonly { readonly reason: string; readonly count: number }[];
  readonly waiting: { readonly needsYou: number; readonly handOff: number };
}

const reasonOf = (result: string, detail: string): string => {
  const d = detail.replace(/\s+/g, " ").trim();
  const text = d ? `${result}: ${d}` : result;
  return text.length > MAX_REASON_CHARS ? `${text.slice(0, MAX_REASON_CHARS - 1)}…` : text;
};

export function countScoreboard(i: ScoreboardInput): Scoreboard {
  const routed = i.caught.filter((r) => r.apply_lane_at && r.created_at && r.apply_lane_at.getTime() - r.created_at.getTime() <= ROUTE_WITHIN_MS);
  const via = (v: string) => i.submitted.filter((s) => s.via === v).length;
  const afterClick = via("telegram") + via("miniapp");
  const byHand = via("by-hand");
  const vps = i.attempts;
  const reasons = new Map<string, number>();
  for (const r of i.results) {
    if (r.result === "confirmed") continue;
    const key = reasonOf(r.result, r.detail);
    reasons.set(key, (reasons.get(key) ?? 0) + 1);
  }
  return {
    caught: i.caught.length,
    routedWithin2h: routed.length,
    filled: i.caught.filter((r) => r.apply_lane).length,
    sent: vps + afterClick + byHand,
    sentBy: { vps, afterClick, byHand },
    confirmed: i.submitted.length,
    clicks: afterClick,
    failed: [...reasons].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
    waiting: {
      needsYou: i.waitingLanes.filter((l) => l === "needs_you").length,
      handOff: i.waitingLanes.filter((l) => l === "hand_off").length,
    },
  };
}

/** True when the day recorded nothing at all, so the evening batch can skip an empty line. */
export const isEmptyScoreboard = (s: Scoreboard): boolean =>
  s.caught + s.filled + s.sent + s.confirmed + s.failed.length + s.waiting.needsYou + s.waiting.handOff === 0;

function lines(name: string, s: Scoreboard): string[] {
  const by = [`VPS ${s.sentBy.vps}`, `after your click ${s.sentBy.afterClick}`, ...(s.sentBy.byHand > 0 ? [`by hand ${s.sentBy.byHand}`] : [])].join(", ");
  const out = [
    `<b>Scoreboard${name ? ` (${esc(name)})` : ""}: ${s.sent} sent, ${TARGET_LINE}</b>`,
    `Caught ${s.caught} → routed within 2h ${s.routedWithin2h} → filled ${s.filled} → sent ${s.sent} → confirmed ${s.confirmed}`,
    `Sent by: ${by}`,
    `Your clicks: ${s.clicks}`,
    `Waiting: needs you ${s.waiting.needsYou}, hand-off ${s.waiting.handOff}`,
  ];
  if (s.failed.length === 0) out.push("Failed: 0");
  else {
    out.push(`Failed: ${s.failed.reduce((n, f) => n + f.count, 0)}`);
    for (const f of s.failed) out.push(`• ${f.count} × ${esc(f.reason)}`);
  }
  return out;
}

/** The scoreboard as one or more messages: split on line boundaries, never by dropping a row. */
export function formatScoreboard(name: string, s: Scoreboard, maxChars: number = SCOREBOARD_MESSAGE_MAX_CHARS): string[] {
  const messages: string[] = [];
  let cur: string[] = [];
  let len = 0;
  for (const line of lines(name, s)) {
    if (cur.length > 0 && len + line.length + 1 > maxChars) {
      messages.push(cur.join("\n"));
      cur = [];
      len = 0;
    }
    cur.push(line);
    len += line.length + 1;
  }
  if (cur.length > 0) messages.push(cur.join("\n"));
  return messages;
}

/** [start, end) of the calendar day containing `now` in `timeZone`, as UTC instants (DST-safe for whole days). */
export function dayWindow(now: Date, timeZone: string): { start: Date; end: Date } {
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const midnight = (day: string): Date => {
    const guess = Date.parse(`${day}T00:00:00Z`);
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(guess));
    const g = (t: string): number => Number(parts.find((x) => x.type === t)?.value ?? 0);
    const asLocal = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"));
    return new Date(guess - (asLocal - guess));
  };
  const next = new Date(Date.parse(`${ymd}T00:00:00Z`) + 36 * 3_600_000).toISOString().slice(0, 10);
  return { start: midnight(ymd), end: midnight(next) };
}
