/**
 * FounderOS — recall_conversation: "what did I ask you yesterday?"
 * ================================================================
 * Reads the conversation log (src/db/conversation-turns.ts) and answers in the founder's own words.
 * The planner replays only the current session; this is the way back to anything older.
 *
 * Shaped for how a person remembers, because the admin prompt relays tool output verbatim, so this
 * text IS the founder-facing reply:
 *   - TIME IS SAID THE HUMAN WAY. The tool takes "yesterday", "last week", "monday", "3 days ago",
 *     "2026-09-30" and resolves them here, in pure code against an injected clock. The worker has no
 *     "now" line; a model doing calendar arithmetic would be guessing. A phrase it cannot read is
 *     refused with the forms it does read, never guessed at.
 *   - THE FOUNDER'S WORDS COME BACK, quoted, with the day. Recognising a message is easier than
 *     describing it, so the answer shows what he sent rather than a summary of it.
 *   - THE RANGE IS SHOWN. "yesterday (Sat 3 Oct)" lets a wrong reading be spotted and corrected in
 *     one reply instead of trusted.
 *   - FIVE AT A TIME. A day can hold dozens of messages; five fit a glance, and the rest wait behind
 *     "show more" (up to 12), with the count stated so nothing is hidden silently.
 *   - AN EMPTY ANSWER EXPLAINS ITSELF. It says what was searched and, when the range reaches before
 *     the log began, how far back memory goes, so "nothing found" is never read as "you never said it".
 *
 * PRIVACY: every read is scoped to ONE thread id. Without it the tool refuses; a guest in an
 * allow-listed group chat runs every non-HITL tool and must not read the founder's private chat.
 */

import type { Clock } from "../core/time.js";
import { wallDate, zoneWeekday, zonedTimeToUtc } from "../core/time.js";
import { tokenizeQuery } from "../db/keyword-search.js";
import type { RecalledTurn, TurnPage, TurnQuery } from "../db/conversation-turns.js";

export interface TurnReader {
  find(query: TurnQuery): Promise<TurnPage>;
  earliest(threadId: string): Promise<Date | null>;
}

export interface RecallDeps {
  readonly reader: TurnReader;
  readonly clock: Clock;
  readonly timeZone: string;
}

export interface RecallInput {
  /** The kernel thread this call runs in (`<tenant>:<chat id>`). Required: it is the privacy boundary. */
  readonly threadId: string;
  /** A time in the founder's words: "yesterday", "last week", "monday", "3 days ago", "2026-09-30". */
  readonly when?: string | null | undefined;
  /** Words to look for in what was said. */
  readonly about?: string | null | undefined;
  /** The founder asked to see more of what was found. */
  readonly more?: boolean | undefined;
}

export interface RecallWindow {
  readonly since: Date;
  /** Exclusive. */
  readonly until: Date;
  /** The range as a person would write it: "Sat 3 Oct", "Mon 21 Sep – now". */
  readonly label: string;
}

const SHOWN_FIRST = 5;
const SHOWN_MORE = 12;
const QUOTE_MAX = 160;
const REPLY_MAX = 240;
const MAX_DAYS_BACK = 3650;

// ── Time, said the human way ──────────────────────────────────────────────────

const WEEKDAYS: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};
const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const FULL_WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const FULL_MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};
/** Parts of a day: [start hour, end hour] on the 24 h clock; "night" runs past midnight to 06:00. */
const DAY_PARTS: Record<string, readonly [number, number]> = {
  morning: [0, 12], afternoon: [12, 18], evening: [18, 24], night: [18, 30],
};

function dayLabel(when: Date, tz: string, withYear = false): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(withYear ? { year: "numeric" as const } : {}),
  })
    .format(when)
    .replace(/,/g, "");
}

const sameDay = (a: Date, b: Date, tz: string): boolean => {
  const x = wallDate(a, tz);
  const y = wallDate(b, tz);
  return x.y === y.y && x.mo === y.mo && x.d === y.d;
};

/** "Sat 3 Oct", or "Mon 21 Sep – Sun 4 Oct"; a range that runs up to today ends in "now". */
function rangeLabel(since: Date, until: Date, now: Date, tz: string): string {
  const last = new Date(until.getTime() - 1);
  if (sameDay(since, last, tz)) return dayLabel(since, tz);
  const end = sameDay(last, now, tz) ? "now" : dayLabel(last, tz);
  return `${dayLabel(since, tz)} – ${end}`;
}

function isoDay(text: string): { y: number; mo: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const check = new Date(Date.UTC(y, mo - 1, d));
  return check.getUTCFullYear() === y && check.getUTCMonth() === mo - 1 && check.getUTCDate() === d ? { y, mo, d } : null;
}

/**
 * Resolve a time phrase to a window in the founder's zone, or null when it cannot be read.
 * Pure: the clock is passed in. "last week" and "last month" deliberately run to the end of today
 * rather than stopping at the week's end, so a near-miss on the boundary never hides the answer;
 * the label says so ("Mon 21 Sep – now").
 */
export function resolveRecallWindow(phrase: string, now: Date, tz: string): RecallWindow | null {
  const text = phrase
    .toLowerCase()
    .trim()
    .replace(/[.,!?]+$/g, "")
    .replace(/^(?:(?:on|in|during|from|the)\s+)+/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text === "") return null;

  const today = wallDate(now, tz);
  const todayWd = zoneWeekday(now, tz);
  const at = (offsetDays: number, hour = 0): Date => zonedTimeToUtc(today.y, today.mo, today.d + offsetDays, hour, 0, tz);
  const window = (since: Date, until: Date): RecallWindow => ({ since, until, label: rangeLabel(since, until, now, tz) });
  const oneDay = (daysBack: number): RecallWindow => window(at(-daysBack), at(-daysBack + 1));
  const toNow = (daysBack: number): RecallWindow => window(at(-daysBack), at(1));

  if (text === "today") return oneDay(0);
  if (text === "yesterday") return oneDay(1);

  // "this morning", "yesterday evening", "last night", "tonight"
  const part = /^(this|today|yesterday|last)\s+(morning|afternoon|evening|night)$/.exec(text === "tonight" ? "this night" : text);
  if (part) {
    const daysBack = part[1] === "this" || part[1] === "today" ? 0 : 1;
    const [from, to] = DAY_PARTS[part[2]!]!;
    const since = at(-daysBack, from);
    return { since, until: at(-daysBack, to), label: `${dayLabel(since, tz)} ${part[2]}` };
  }

  if (text === "this week") return toNow((todayWd + 6) % 7);
  if (text === "last week") return toNow((todayWd + 6) % 7 + 7);
  if (text === "recently" || text === "lately" || text === "a few days ago" || text === "other day") return toNow(7);
  if (text === "this month" || text === "last month") {
    const mo = text === "this month" ? today.mo : today.mo - 1;
    return window(zonedTimeToUtc(today.y, mo, 1, 0, 0, tz), at(1));
  }

  // "3 days ago" is that one day; "past 5 days" / "last two weeks" run up to now.
  const ago = /^(\d{1,4}|[a-z]+) days? ago$/.exec(text);
  const past = /^(?:past|last|previous) (\d{1,4}|[a-z]+) (day|week)s?$/.exec(text);
  const amount = (word: string): number | null => (/^\d+$/.test(word) ? Number(word) : NUMBER_WORDS[word] ?? null);
  if (ago) {
    const n = amount(ago[1]!);
    return n !== null && n >= 1 && n <= MAX_DAYS_BACK ? oneDay(n) : null;
  }
  if (past) {
    const n = amount(past[1]!);
    const days = n === null ? null : n * (past[2] === "week" ? 7 : 1);
    return days !== null && days >= 1 && days <= MAX_DAYS_BACK ? toNow(days) : null;
  }

  // "monday" is the most recent one (today counts); "last monday" is strictly before today.
  const weekday = /^(last )?([a-z]+)$/.exec(text);
  if (weekday) {
    const name = weekday[2]!;
    const wd = FULL_WEEKDAYS.indexOf(name) >= 0 ? FULL_WEEKDAYS.indexOf(name) : name.length === 3 ? WEEKDAYS[name] : undefined;
    if (wd !== undefined) {
      const back = (todayWd - wd + 7) % 7;
      return oneDay(weekday[1] && back === 0 ? 7 : back);
    }
  }

  // "2026-09-30", "2026-09-28 to 2026-09-30" (inclusive)
  const range = /^(\d{4}-\d{2}-\d{2}) (?:to|until|through|-) (\d{4}-\d{2}-\d{2})$/.exec(text);
  const [startText, endText] = range ? [range[1]!, range[2]!] : [text, text];
  const start = isoDay(startText);
  const end = isoDay(endText);
  if (start && end) {
    const since = zonedTimeToUtc(start.y, start.mo, start.d, 0, 0, tz);
    const until = zonedTimeToUtc(end.y, end.mo, end.d + 1, 0, 0, tz);
    return until > since ? window(since, until) : null;
  }

  // "28 sep", "sep 28", "28th september": this year, or last year when that date is still ahead.
  const dm = /^(\d{1,2})(?:st|nd|rd|th)? ([a-z]{3,9})$/.exec(text) ?? /^([a-z]{3,9}) (\d{1,2})(?:st|nd|rd|th)?$/.exec(text);
  if (dm) {
    const [dayText, monthText] = /^\d/.test(dm[1]!) ? [dm[1]!, dm[2]!] : [dm[2]!, dm[1]!];
    const mo = MONTHS[monthText.slice(0, 3)];
    const isMonthName = mo !== undefined && FULL_MONTHS[mo - 1]!.startsWith(monthText);
    if (isMonthName && isoDay(`${today.y}-${String(mo).padStart(2, "0")}-${dayText.padStart(2, "0")}`)) {
      const d = Number(dayText);
      const thisYear = zonedTimeToUtc(today.y, mo, d, 0, 0, tz);
      const y = thisYear.getTime() >= at(1).getTime() ? today.y - 1 : today.y;
      return window(zonedTimeToUtc(y, mo, d, 0, 0, tz), zonedTimeToUtc(y, mo, d + 1, 0, 0, tz));
    }
  }
  return null;
}

// ── Words that carry no topic ─────────────────────────────────────────────────

/** Verbs and time words that wrap a recall question; the time is already in `when`, the verbs say nothing about the topic. */
const RECALL_FILLER = new Set([
  "say", "said", "says", "ask", "asked", "asking", "tell", "told", "mention", "mentioned", "mentioning", "talk", "talked",
  "talking", "earlier", "before", "ago", "last", "week", "weeks", "month", "months", "day", "days", "yesterday", "today",
  "tonight", "morning", "evening", "afternoon", "night", "recently", "lately", "conversation", "conversations", "message",
  "messages", "chat", "thing", "things", "please", "find", "search", "look", "looking", "ever", "again", "past",
]);

function topicTerms(about: string): string[] {
  return tokenizeQuery(about).filter((t) => !RECALL_FILLER.has(t));
}

// ── Output ────────────────────────────────────────────────────────────────────

/** One line, cut at a word boundary with an ellipsis. */
function brief(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

function clockTime(when: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true }).formatToParts(when);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("hour")}:${get("minute")} ${get("dayPeriod").toUpperCase()}`;
}

/** "Today, 3:30 PM" · "Yesterday, 9:41 PM" · "Mon 28 Sep, 9:41 PM" (with the year once it is not this one). */
function whenLine(when: Date, now: Date, tz: string): string {
  const here = wallDate(now, tz);
  const there = wallDate(when, tz);
  const daysApart = Math.round((Date.UTC(here.y, here.mo - 1, here.d) - Date.UTC(there.y, there.mo - 1, there.d)) / 86_400_000);
  const day = daysApart === 0 ? "Today" : daysApart === 1 ? "Yesterday" : dayLabel(when, tz, here.y !== there.y);
  return `${day}, ${clockTime(when, tz)}`;
}

function renderTurn(turn: RecalledTurn, now: Date, tz: string): string {
  const lines = [whenLine(turn.occurred_at, now, tz), `You: "${brief(turn.user_input, QUOTE_MAX)}"`];
  const reply = brief(turn.reply, REPLY_MAX);
  if (turn.outcome === "failed") lines.push(`Me: that one failed${reply ? ` — ${reply}` : ""}`);
  else if (reply) lines.push(`Me: ${reply}`);
  return lines.join("\n");
}

const READABLE_TIMES = `yesterday, last week, monday, 3 days ago, past 5 days, or a date like 2026-09-30`;

function emptyAnswer(topic: string, windowText: string, window: RecallWindow | null, earliest: Date | null, tz: string): string {
  if (earliest === null) {
    return "I haven't saved any conversations from this chat yet, so there's nothing to search. From now on I keep them.";
  }
  const lines = [`I found nothing${topic}${windowText}.`];
  if (window === null || window.since < earliest) {
    lines.push(
      `I only started keeping conversations on ${dayLabel(earliest, tz, true)}, so anything before that isn't something I can search. ` +
        `An empty result for earlier days isn't a sign you never said it.`,
    );
  }
  lines.push("Try a wider time range or a different word.");
  return lines.join("\n");
}

// ── The tool ──────────────────────────────────────────────────────────────────

export async function recallConversation(input: RecallInput, deps: RecallDeps): Promise<string> {
  const { reader, clock, timeZone: tz } = deps;
  if (input.threadId.trim() === "") {
    return "I can't tell which chat this is, so I won't search conversations. (That keeps one chat from reading another's.)";
  }

  const whenText = input.when?.trim() ?? "";
  const window = whenText === "" ? null : resolveRecallWindow(whenText, clock(), tz);
  if (whenText !== "" && window === null) {
    return `I couldn't read the time "${whenText}". Try ${READABLE_TIMES}.`;
  }

  const aboutText = input.about?.trim() ?? "";
  const terms = aboutText === "" ? [] : topicTerms(aboutText);
  if (aboutText !== "" && terms.length === 0) {
    return `"${aboutText}" is all filler words, so it would match everything. Give me a more specific word to search for.`;
  }

  const limit = input.more ? SHOWN_MORE : SHOWN_FIRST;
  const [page, earliest] = await Promise.all([
    reader.find({
      threadId: input.threadId,
      ...(window ? { since: window.since, until: window.until } : {}),
      terms,
      limit,
    }),
    reader.earliest(input.threadId),
  ]);

  const topic = terms.length > 0 ? ` mentioning "${terms.join(" ")}"` : "";
  const windowText = window ? ` from ${whenText.toLowerCase()} (${window.label})` : "";
  if (page.total === 0) return emptyAnswer(topic, windowText.replace(" from ", " for "), window, earliest, tz);

  const shown = page.turns.length;
  const noun = `message${page.total === 1 ? "" : "s"}`;
  const heading =
    shown < page.total
      ? `Showing the ${terms.length > 0 ? "top" : "latest"} ${shown} of ${page.total} ${noun}${topic}${windowText}:`
      : `${page.total} ${noun}${topic}${windowText}:`;

  const chronological = [...page.turns].sort((a, b) => a.occurred_at.getTime() - b.occurred_at.getTime());
  const now = clock();
  const out = [heading, "", chronological.map((t) => renderTurn(t, now, tz)).join("\n\n")];

  const left = page.total - shown;
  if (left > 0) {
    out.push(
      "",
      input.more
        ? `${left} more not shown. Add a word or a date to narrow it down.`
        : `${left} more. Say "show more" and I'll list up to ${SHOWN_MORE}.`,
    );
  }
  if (earliest !== null && window !== null && window.since < earliest) {
    out.push("", `(I only have conversations from ${dayLabel(earliest, tz, true)} onward.)`);
  }
  return out.join("\n");
}

/**
 * For search_memory's "all" search: this chat's saved messages that mention `query`, or null when nothing does, so a
 * search across every source stays quiet about a source with no hits. A bare `about` search with the explicit answers
 * (empty-log explanation, filler-word refusal) is `recallConversation`; this is its short form.
 */
export async function searchTurnLog(
  threadId: string,
  query: string,
  deps: RecallDeps,
  limit = 4,
): Promise<string | null> {
  const terms = topicTerms(query);
  if (threadId.trim() === "" || terms.length === 0) return null;
  const page = await deps.reader.find({ threadId, terms, limit });
  if (page.total === 0) return null;

  const now = deps.clock();
  const chronological = [...page.turns].sort((a, b) => a.occurred_at.getTime() - b.occurred_at.getTime());
  const out = chronological.map((t) => renderTurn(t, now, deps.timeZone));
  const left = page.total - page.turns.length;
  if (left > 0) out.push(`${left} more. Ask me to recall "${terms.join(" ")}" to see them.`);
  return out.join("\n\n");
}
