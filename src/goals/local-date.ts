/**
 * FounderOS — goals: local dates
 * ==============================
 * `review_date` is the date in the APP timezone (`appTimeZone()`), not UTC: at 23:30 UTC it
 * is already tomorrow in Amsterdam, and a standup keyed on the UTC date would fire twice
 * for one local day or skip one. Every function takes the zone explicitly, so it is pure and
 * testable with a fixed instant; callers pass `appTimeZone()`.
 *
 * Date keys are `YYYY-MM-DD` strings and compare correctly as strings.
 */

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const DAY_MS = 86_400_000;

const formatters = new Map<string, Intl.DateTimeFormat>();

function wallClock(at: Date, timeZone: string): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    // Throws RangeError for an unknown zone: a misconfigured APP_TIMEZONE must be loud, not quietly UTC.
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, fmt);
  }
  const part = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(fmt.formatToParts(at).find((p) => p.type === type)?.value);
  return { y: part("year"), mo: part("month"), d: part("day"), h: part("hour") % 24, mi: part("minute"), s: part("second") };
}

const pad = (n: number, width: number): string => String(n).padStart(width, "0");

/** The `YYYY-MM-DD` date an instant falls on in `timeZone`. */
export function localDateKey(at: Date, timeZone: string): string {
  const { y, mo, d } = wallClock(at, timeZone);
  return `${pad(y, 4)}-${pad(mo, 2)}-${pad(d, 2)}`;
}

/** Minutes since local midnight (0–1439) of an instant in `timeZone`. */
export function localMinutesOfDay(at: Date, timeZone: string): number {
  const { h, mi } = wallClock(at, timeZone);
  return h * 60 + mi;
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** True for a real calendar date written exactly `YYYY-MM-DD`. */
export function isValidDateKey(key: string): boolean {
  if (key.length !== 10 || key[4] !== "-" || key[7] !== "-") return false;
  const [ys, ms, ds] = [key.slice(0, 4), key.slice(5, 7), key.slice(8, 10)];
  if (![ys, ms, ds].every((p) => [...p].every((c) => c >= "0" && c <= "9"))) return false;
  const [y, m, d] = [Number(ys), Number(ms), Number(ds)];
  return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

function parseKey(key: string): { y: number; m: number; d: number } {
  if (!isValidDateKey(key)) throw new RangeError(`not a YYYY-MM-DD date: ${JSON.stringify(key)}`);
  return { y: Number(key.slice(0, 4)), m: Number(key.slice(5, 7)), d: Number(key.slice(8, 10)) };
}

/**
 * The instant local midnight begins `dateKey` in `timeZone`.
 *
 * The zone's offset is read at a first guess and then again at the corrected instant, so the
 * two DST-change days (23 and 25 hours long) come out right rather than an hour off.
 */
export function startOfLocalDay(dateKey: string, timeZone: string): Date {
  const { y, m, d } = parseKey(dateKey);
  const utcMidnight = Date.UTC(y, m - 1, d);
  const offsetAt = (instant: number): number => {
    const w = wallClock(new Date(instant), timeZone);
    return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(instant / 1000) * 1000;
  };
  const first = utcMidnight - offsetAt(utcMidnight);
  return new Date(utcMidnight - offsetAt(first));
}

/** Whole days from `fromKey` to `toKey` (negative when `toKey` is earlier). */
export function daysBetween(fromKey: string, toKey: string): number {
  const a = parseKey(fromKey);
  const b = parseKey(toKey);
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / DAY_MS);
}

export function addDays(key: string, days: number): string {
  const { y, m, d } = parseKey(key);
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  return `${pad(shifted.getUTCFullYear(), 4)}-${pad(shifted.getUTCMonth() + 1, 2)}-${pad(shifted.getUTCDate(), 2)}`;
}

/** "Wed 30 Sep": the standup header. */
export function formatDayLabel(key: string): string {
  const { y, m, d } = parseKey(key);
  return `${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${d} ${MONTHS[m - 1]}`;
}

/** "31 Oct". */
export function formatShortDate(key: string): string {
  const { m, d } = parseKey(key);
  return `${d} ${MONTHS[m - 1]}`;
}
