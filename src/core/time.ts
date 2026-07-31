/**
 * FounderOS — timezone / clock utilities (founder-facing time is IST).
 * ====================================================================
 * The server stays on UTC — logs, the checkpointer and infra/timestamp.ts all
 * agree on one clock. This module is the ONE presentation/parse layer that maps
 * UTC to the founder's local zone and back:
 *   - the planner is told "now" in the founder's zone so it can resolve
 *     "tomorrow 9am" without guessing (kernel/planner.ts injects plannerNowLine);
 *   - reminders/scheduled tasks confirm and display fire-times in that zone.
 *
 * The clock is INJECTED (Clock) so determinism holds: the golden set runs twice
 * and must produce identical plans — a bare `new Date()` in a prompt would break
 * that. Prod passes the real clock; tests pass a frozen one.
 *
 * Dependency-free on purpose (Intl only). The default zone (Asia/Kolkata) has a
 * fixed +05:30 offset and no DST, so the offset arithmetic below is exact for it;
 * for a DST zone it is correct except within the transition hour, which is
 * acceptable for human reminders.
 */

import { env } from "./config.js";

/** Injectable "now" source. Default is the real wall clock. */
export type Clock = () => Date;
export const systemClock: Clock = () => new Date();

/** Simple repeat rules the reminder sweep can re-arm from with zero LLM. */
export type Recurrence =
  | { kind: "daily"; time: string } // "HH:MM", every day
  | { kind: "weekdays"; time: string } // "HH:MM", Mon–Fri
  | { kind: "weekly"; weekday: number; time: string } // weekday 0=Sun..6=Sat
  | { kind: "monthly"; day: number; time: string }; // day 1..31, clamped to month length

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** The founder-facing timezone (IANA), e.g. "Asia/Kolkata". */
export function appTimeZone(): string {
  return env.APP_TIMEZONE;
}

/**
 * Short zone label for display, e.g. "IST". Node's "short" timeZoneName often
 * renders "GMT+5:30" (no CLDR abbreviation), so derive the abbreviation from the
 * long name's initials ("India Standard Time" → "IST") and fall back to the
 * unambiguous offset ("UTC+05:30") when there is no proper name.
 */
export function zoneAbbrev(when: Date, timeZone = appTimeZone()): string {
  const long =
    new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "long" })
      .formatToParts(when)
      .find((p) => p.type === "timeZoneName")?.value ?? "";
  if (long && !/^GMT/i.test(long)) {
    const initials = long
      .split(/\s+/)
      .map((w) => w[0])
      .filter((c) => c != null && /[A-Za-z]/.test(c))
      .join("")
      .toUpperCase();
    if (initials.length >= 2) return initials;
  }
  return `UTC${zoneOffset(when, timeZone)}`;
}

/** UTC offset for a zone at an instant, formatted "+05:30". */
export function zoneOffset(when: Date, timeZone = appTimeZone()): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" }).formatToParts(when);
  const raw = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT+00:00";
  const off = raw.replace("GMT", "").trim();
  return off === "" ? "+00:00" : off;
}

/** Offset east of UTC in minutes at an instant, e.g. +330 for IST. */
function offsetMinutes(when: Date, timeZone: string): number {
  const off = zoneOffset(when, timeZone); // "+05:30" | "-04:00"
  const sign = off.startsWith("-") ? -1 : 1;
  const [h, m] = off.slice(1).split(":").map(Number);
  return sign * ((h ?? 0) * 60 + (m ?? 0));
}

/** The Y/M/D wall-clock date of an instant in a zone. */
function wallDate(when: Date, timeZone: string): { y: number; mo: number; d: number } {
  // en-CA renders "2026-07-23" — stable, parseable.
  const [y, mo, d] = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(when)
    .split("-")
    .map(Number);
  return { y: y!, mo: mo!, d: d! };
}

/** Weekday of an instant in a zone: 0=Sun..6=Sat. */
function zoneWeekday(when: Date, timeZone: string): number {
  const wd = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(when);
  return WEEKDAY_NAMES.indexOf(wd as (typeof WEEKDAY_NAMES)[number]);
}

/** Build the UTC instant for a target wall-clock time (Y-M-D H:M) in a zone. */
function zonedTimeToUtc(y: number, mo: number, d: number, h: number, mi: number, timeZone: string): Date {
  // Treat the wall time as if it were UTC, then subtract the zone's offset at
  // that instant. Date.UTC folds day/month overflow (d + N) correctly.
  const guess = new Date(Date.UTC(y, mo - 1, d, h, mi, 0, 0));
  return new Date(guess.getTime() - offsetMinutes(guess, timeZone) * 60_000);
}

/** Founder-facing absolute time, e.g. "Wed 23 Jul 2026, 9:00 AM IST". */
export function formatInZone(when: Date, timeZone = appTimeZone()): string {
  const base = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  })
    .format(when)
    .replace(/,/g, "")
    .replace(/\b(am|pm)\b/i, (s) => s.toUpperCase());
  return `${base} ${zoneAbbrev(when, timeZone)}`;
}

/**
 * The line injected into the planner so it resolves relative/bare times against
 * the founder's real "now" instead of guessing. See kernel/planner.ts.
 */
export function plannerNowLine(clock: Clock = systemClock, timeZone = appTimeZone()): string {
  const now = clock();
  return (
    `Current time: ${formatInZone(now, timeZone)} (${timeZone}, UTC${zoneOffset(now, timeZone)}). ` +
    `Interpret any bare clock time the founder gives ("9am", "18:00", "tonight", "tomorrow") as ${zoneAbbrev(now, timeZone)}. ` +
    `Emit scheduled_at / remind_at as a full ISO 8601 datetime WITH that offset. Never pick a time already in the past.`
  );
}

/**
 * Next fire instant (UTC) for a recurrence, strictly AFTER `after`. Pure — the
 * reminder sweep calls this to re-arm a recurring row with zero LLM.
 */
export function nextRecurrence(rec: Recurrence, after: Date, timeZone = appTimeZone()): Date {
  const [th, tm] = rec.time.split(":").map(Number);
  const { y, mo, d } = wallDate(after, timeZone);

  // Monthly needs a month-stepping scan, and the requested day is clamped into
  // short months so "the 31st" fires on 30 Sep rather than silently skipping it.
  if (rec.kind === "monthly") {
    for (let i = 0; i <= 13; i++) {
      const ty = y + Math.floor((mo - 1 + i) / 12);
      const tmo = ((mo - 1 + i) % 12) + 1;
      const lastDay = new Date(Date.UTC(ty, tmo, 0)).getUTCDate();
      const cand = zonedTimeToUtc(ty, tmo, Math.min(rec.day, lastDay), th ?? 0, tm ?? 0, timeZone);
      if (cand.getTime() > after.getTime()) return cand;
    }
    throw new Error(`nextRecurrence: no fire time within 13 months for ${JSON.stringify(rec)}`);
  }

  for (let i = 0; i < 8; i++) {
    const cand = zonedTimeToUtc(y, mo, d + i, th ?? 0, tm ?? 0, timeZone);
    if (cand.getTime() <= after.getTime()) continue;
    const wd = zoneWeekday(cand, timeZone);
    if (rec.kind === "daily") return cand;
    if (rec.kind === "weekdays" && wd >= 1 && wd <= 5) return cand;
    if (rec.kind === "weekly" && wd === rec.weekday) return cand;
  }
  // 8 days always contains a match for daily/weekdays/weekly — unreachable.
  throw new Error(`nextRecurrence: no fire time within 8 days for ${JSON.stringify(rec)}`);
}

const WEEKDAY_KEYS: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

function validTime(time: string): boolean {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!m) return false;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  return h >= 0 && h <= 23 && mi >= 0 && mi <= 59;
}

/**
 * Parse a recurrence spec string so schedules can be stored as text and re-armed
 * without an LLM. Returns null on anything malformed — a scheduler that guesses at
 * an ambiguous schedule is worse than one that refuses it.
 *
 * Forms: `daily@08:07` · `weekdays@09:00` · `weekly@mon:09:12` · `monthly@01:06:07`
 */
export function parseRecurrence(spec: string): Recurrence | null {
  const simple = /^(daily|weekdays)@(\d{1,2}:\d{2})$/i.exec(spec);
  if (simple) {
    const time = simple[2]!;
    if (!validTime(time)) return null;
    return { kind: simple[1]!.toLowerCase() as "daily" | "weekdays", time };
  }

  const weekly = /^weekly@([a-z]{3}):(\d{1,2}:\d{2})$/i.exec(spec);
  if (weekly) {
    const weekday = WEEKDAY_KEYS[weekly[1]!.toLowerCase()];
    const time = weekly[2]!;
    if (weekday === undefined || !validTime(time)) return null;
    return { kind: "weekly", weekday, time };
  }

  const monthly = /^monthly@(\d{1,2}):(\d{1,2}:\d{2})$/i.exec(spec);
  if (monthly) {
    const day = Number(monthly[1]);
    const time = monthly[2]!;
    if (day < 1 || day > 31 || !validTime(time)) return null;
    return { kind: "monthly", day, time };
  }

  return null;
}

/** Human label for a recurrence, e.g. "every weekday at 18:00". */
export function describeRecurrence(rec: Recurrence): string {
  if (rec.kind === "daily") return `every day at ${rec.time}`;
  if (rec.kind === "weekdays") return `every weekday at ${rec.time}`;
  if (rec.kind === "monthly") return `on day ${rec.day} of each month at ${rec.time}`;
  return `every ${WEEKDAY_NAMES[rec.weekday] ?? "?"} at ${rec.time}`;
}
