/**
 * FounderOS — the founder-context renderer (pure)
 * ================================================
 * Turns the stored founder_context row into the text read_context and search_memory
 * hand a model, and /focus and /projects show the founder. Every value is printed
 * with the date it was last confirmed:
 *
 *   • current focus: Close the Acme pilot (confirmed 2026-09-30)
 *   • current focus: Phase D-Bis: 3 proof showcases … ⚠ last confirmed 2026-06-12, may be out of date: ask before relying on it
 *   • current focus: Phase D-Bis: 3 proof showcases … ⚠ date unknown, may be out of date: ask before relying on it
 *
 * Why code does this and a prompt does not: on 2026-09-29 the bot quoted June's plan
 * as the founder's current focus, because the model could not tell a value he
 * confirmed yesterday from one the seed wrote in June. The dates live in
 * `context_meta` (src/db/context-meta.ts); the flag is computed here; the planner
 * rule ("a line marked ⚠ must be stated with its date, or asked about") has a real
 * input to act on.
 *
 * Dates are the founder's, not UTC's: they are read in the app time zone, so a value
 * confirmed at 00:30 IST on the 30th says 2026-09-30. Age is counted in calendar days
 * between the dates he reads, so "confirmed 2026-08-30" on 2026-09-30 is 31 days.
 *
 * Pure: `now` and the zone are arguments. Only the tool wrappers read the real clock.
 */

import {
  CONTEXT_STALE_MARKER,
  readContextMeta,
  type ContextMetaEntry,
} from "../db/context-meta.js";
import { LAST_UPDATED_KEY, founderFacingContext } from "../db/founder-context.js";
import { appTimeZone, wallDate } from "../core/time.js";

/** A value last confirmed by the founder (or seeded) more than this many calendar days ago is flagged as possibly out of date. */
export const CONTEXT_STALE_DAYS = 30;

/** What a flagged line tells its reader to do; the planner rule repeats it. */
export const CONTEXT_STALE_ADVICE = "may be out of date: ask before relying on it";

/** What read_context returns when the row holds no founder-facing context. */
export const NO_CONTEXT_MESSAGE =
  "No business context stored yet. Ask the founder to share their current priorities and active clients so you can remember them.";

const DAY_MS = 86_400_000;

export interface RenderContextOptions {
  /** IANA zone the dates are read in; the app time zone when omitted. */
  readonly timeZone?: string;
  /** Called at most once per render with why context_meta could not be fully read. */
  readonly warn?: (problem: string) => void;
}

interface Ymd {
  readonly y: number;
  readonly mo: number;
  readonly d: number;
}

const dayNumber = ({ y, mo, d }: Ymd): number => Date.UTC(y, mo - 1, d) / DAY_MS;
const isoDay = ({ y, mo, d }: Ymd): string => `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/** The tag after a value: its date, or the mark and the advice when it may be stale or has no date. */
function datedTag(entry: ContextMetaEntry | undefined, now: Date, timeZone: string): string {
  const unknown = `${CONTEXT_STALE_MARKER} date unknown, ${CONTEXT_STALE_ADVICE}`;
  if (entry === undefined) return unknown;
  const at = new Date(entry.at);
  if (at.getTime() <= 0) return unknown; // the 1970-01-01 sentinel: a date nobody knows

  const today = wallDate(now, timeZone);
  const written = wallDate(at, timeZone);
  // A date in the future is clock skew: read as today, never as negative days.
  const shown = dayNumber(written) > dayNumber(today) ? today : written;
  const ageDays = dayNumber(today) - dayNumber(shown);
  const verb = entry.source === "seed" ? "seeded" : "confirmed";
  // A code-owned value is rewritten by every deploy that changes it: it does not age out.
  if (entry.source !== "system" && ageDays > CONTEXT_STALE_DAYS) {
    return `${CONTEXT_STALE_MARKER} last ${verb} ${isoDay(shown)}, ${CONTEXT_STALE_ADVICE}`;
  }
  return `(${verb} ${isoDay(shown)})`;
}

function renderItem(item: unknown): string {
  if (typeof item === "string") return item;
  return item !== null && typeof item === "object" ? JSON.stringify(item) : String(item);
}

function renderValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(renderItem).join(", ") || "(none)";
  return value === null || value === undefined || value === "" ? "(none)" : renderItem(value);
}

/**
 * A function that gives the date tag of one key of `ctx` — "(confirmed 2026-09-30)",
 * or the mark and the advice — reading the row's context_meta once. If that meta is
 * unreadable it calls `warn` once, and every tag reads "date unknown": it never throws.
 */
export function contextTagRenderer(
  ctx: Readonly<Record<string, unknown>>,
  now: Date,
  options: RenderContextOptions = {},
): (key: string) => string {
  const timeZone = options.timeZone ?? appTimeZone();
  const { entries, problems } = readContextMeta(ctx);
  if (problems.length > 0) options.warn?.(problems.join("; "));
  return (key) => datedTag(Object.hasOwn(entries, key) ? entries[key] : undefined, now, timeZone);
}

/** One key of `ctx` as a dated line: "• current focus: Close the Acme pilot (confirmed 2026-09-30)". */
export function contextLineRenderer(
  ctx: Readonly<Record<string, unknown>>,
  now: Date,
  options: RenderContextOptions = {},
): (key: string, value: unknown) => string {
  const tag = contextTagRenderer(ctx, now, options);
  return (key, value) => `• ${key.replace(/_/g, " ")}: ${renderValue(value)} ${tag(key)}`;
}

/**
 * The business context as text: one dated line per founder-facing key. Bookkeeping
 * (the budget alert state, context_meta) and the row-level last_updated never
 * appear: that single date under every value is what made June's read as fresh.
 */
export function renderFounderContext(
  ctx: Readonly<Record<string, unknown>>,
  now: Date,
  options: RenderContextOptions = {},
): string {
  const line = contextLineRenderer(ctx, now, options);
  const lines = Object.entries(founderFacingContext(ctx))
    .filter(([key, value]) => key !== LAST_UPDATED_KEY && !(Array.isArray(value) && value.length === 0))
    .map(([key, value]) => line(key, value));
  return lines.length === 0 ? NO_CONTEXT_MESSAGE : `Current business context:\n${lines.join("\n")}`;
}
