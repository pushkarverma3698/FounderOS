/**
 * Pure scorers for the daily journeys (AG-051; plan docs/plans/2026-10-08-simplify-founderos.md §5).
 * Each one compares the bot's reply with what the real source returned. No I/O, no clock, no model:
 * scripts/journey-daily.ts does the reads and passes the results in.
 */

export interface Verdict {
  ok: boolean;
  detail: string;
}

/** A reminder must fire within this long of the ask ("remind me in 2 minutes" + one sweep + slack). */
export const REMINDER_FIRE_LIMIT_MS = 4 * 60_000;
/** Journey A runs every 3 days at 03:00 UTC; a result older than this means a run was missed. */
export const A_LOG_MAX_AGE_H = 80;
/** A real subject or event title is matched on at most this many leading characters (bots shorten long titles). */
export const TITLE_MATCH_CHARS = 30;
/** India has no daylight saving: IST is UTC+5:30 all year. */
export const IST_OFFSET_MS = 330 * 60_000;

/** Lower case, punctuation to spaces, one space between words. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** "Re: Fwd: Invoice" → "invoice", cut to TITLE_MATCH_CHARS on a word boundary where possible. */
function titleKey(title: string): string {
  const n = normalize(title).replace(/^((re|fw|fwd|aw)\s+)+/, "");
  if (n.length <= TITLE_MATCH_CHARS) return n;
  const cut = n.slice(0, TITLE_MATCH_CHARS);
  const space = cut.lastIndexOf(" ");
  return space > 10 ? cut.slice(0, space) : cut;
}

/** True when `reply` names `title` (case and punctuation ignored). */
export function names(reply: string, title: string): boolean {
  const key = titleKey(title);
  return key.length > 0 && ` ${normalize(reply)} `.includes(` ${key} `);
}

const NOTHING = [
  /\bnothing\b/i,
  /\bno (new |important |unread )?(emails?|mail|messages?|events?|meetings?|reminders?|open (prs?|pull requests?))\b/i,
  /\b(is|looks) (empty|clear|free)\b/i,
  /\bempty\b/i,
  /\bnone\b/i,
];

/** The reply says there is nothing to report. */
export function saysNothing(reply: string): boolean {
  return NOTHING.some((re) => re.test(reply));
}

const quoteList = (items: readonly string[], max = 3): string =>
  items
    .slice(0, max)
    .map((s) => `"${s}"`)
    .join(", ") + (items.length > max ? ` and ${items.length - max} more` : "");

/** J1: the reply names at least one real subject from the last 24 h, or says nothing when gws found nothing. */
export function scoreInbox(reply: string, subjects: readonly string[]): Verdict {
  if (subjects.length === 0) {
    return saysNothing(reply)
      ? { ok: true, detail: "gws found no mail in the last 24 h and the bot said so" }
      : { ok: false, detail: "gws found no mail in the last 24 h but the bot did not say there was nothing" };
  }
  const hit = subjects.find((s) => names(reply, s));
  return hit
    ? { ok: true, detail: `named "${hit}" (one of ${subjects.length} real subjects)` }
    : { ok: false, detail: `named none of the ${subjects.length} real subjects, e.g. ${quoteList(subjects)}` };
}

/** J2: every event gws returns for today is named, or the reply says the day is empty. */
export function scoreCalendar(reply: string, events: readonly string[]): Verdict {
  if (events.length === 0) {
    return saysNothing(reply)
      ? { ok: true, detail: "no events today and the bot said so" }
      : { ok: false, detail: "gws has no events today but the bot did not say the day is empty" };
  }
  const missing = events.filter((e) => !names(reply, e));
  return missing.length === 0
    ? { ok: true, detail: `all ${events.length} events named` }
    : { ok: false, detail: `missing from the reply: ${missing.join(", ")} (${events.length - missing.length} of ${events.length} named)` };
}

export interface OpenPr {
  number: number;
  /** summarizeChecks verdict (src/tools/github-pr.ts): green | red | pending | none, or "unavailable: …". */
  ci: string;
  createdAt: string;
}

const VERDICT_WORDS: Record<string, RegExp> = {
  green: /\bgreen\b|\bpass(es|ed|ing)?\b|\bsuccess(ful)?\b|✅|🟢/i,
  red: /\bred\b|\bfail(s|ed|ing|ure)?\b|❌|🔴/i,
  pending: /\bpending\b|\brunning\b|\bin progress\b|\bqueued\b|⏳|🟡/i,
  none: /\bno (ci|checks?)\b|\bnone\b|\bno ci\b/i,
};

/** "#1018", "PR 1018", or a bare markdown table cell "| 1018 |" (the bot answers lists as tables). */
const prRef = (n: number): RegExp => new RegExp(`(#|\\bPR\\s*#?)${n}\\b|\\|\\s*${n}\\s*\\|`, "i");

/** J3: every open PR is named with GitHub's CI verdict on its line; the follow-up names the oldest PR. */
export function scorePrs(reply: string, followUp: string, prs: readonly OpenPr[]): Verdict {
  if (prs.length === 0) {
    return saysNothing(reply) || /\bno open\b/i.test(reply)
      ? { ok: true, detail: "no open PRs and the bot said so" }
      : { ok: false, detail: "GitHub has no open PRs but the bot did not say so" };
  }
  const problems: string[] = [];
  const lines = reply.split("\n");
  for (const pr of prs) {
    const own = lines.filter((l) => prRef(pr.number).test(l));
    if (own.length === 0) {
      problems.push(`#${pr.number} not named`);
      continue;
    }
    const words = VERDICT_WORDS[pr.ci];
    if (words && !own.some((l) => words.test(l))) problems.push(`#${pr.number}: GitHub says ${pr.ci}, the reply does not`);
  }
  const oldest = [...prs].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0]!;
  if (!prRef(oldest.number).test(followUp)) problems.push(`follow-up did not name the oldest PR #${oldest.number}`);
  return problems.length === 0
    ? { ok: true, detail: `all ${prs.length} open PRs and their CI verdicts match GitHub; follow-up named #${oldest.number}` }
    : { ok: false, detail: problems.join("; ") };
}

export interface ReminderInput {
  /** When "remind me in 2 minutes" was sent (ISO). */
  askedAt: string;
  /** The reminders row the ask created, if any. */
  created: { text: string; firedAt: string | null } | undefined;
  /** The bot's answer to "what reminders do I have?". */
  listReply: string;
  /** Texts of the founder's scheduled reminders, read right after that answer. */
  scheduled: readonly string[];
}

/** J5: the reminder fired within REMINDER_FIRE_LIMIT_MS and the list names every scheduled reminder. */
export function scoreReminder(input: ReminderInput): Verdict {
  const { askedAt, created, listReply, scheduled } = input;
  if (!created) return { ok: false, detail: "no reminder row was created for the ask" };
  const limitMin = REMINDER_FIRE_LIMIT_MS / 60_000;
  if (!created.firedAt) return { ok: false, detail: `the reminder had not fired ${limitMin} min after the ask` };
  const tookMs = Date.parse(created.firedAt) - Date.parse(askedAt);
  if (tookMs > REMINDER_FIRE_LIMIT_MS) {
    return { ok: false, detail: `the reminder fired after ${(tookMs / 60_000).toFixed(1)} min (limit ${limitMin} min)` };
  }
  const missing = scheduled.filter((t) => !names(listReply, t));
  if (missing.length > 0) return { ok: false, detail: `the list left out: ${missing.join(", ")}` };
  if (scheduled.length === 0 && !saysNothing(listReply)) {
    return { ok: false, detail: "no reminders are scheduled but the list did not say so" };
  }
  return { ok: true, detail: `fired in ${(tookMs / 60_000).toFixed(1)} min; the list named all ${scheduled.length} scheduled reminders` };
}

/** Journey A's last result, from ~/.claude/journey-a.log (its cron runs every 3 days on its own). */
export function parseJourneyALog(
  text: string | undefined,
  mtimeMs: number | undefined,
  nowMs: number,
): { status: "green" | "red"; detail: string } {
  if (text === undefined || mtimeMs === undefined) return { status: "red", detail: "no journey A log on this host" };
  const last = text
    .split("\n")
    .filter((l) => /^(GREEN|RED) journey A\b/.test(l))
    .pop();
  if (!last) return { status: "red", detail: "the journey A log has no result line" };
  const ageH = (nowMs - mtimeMs) / 3_600_000;
  const said = last.replace(/^(GREEN|RED) journey A( \([^)]*\))?:\s*/, "");
  if (ageH > A_LOG_MAX_AGE_H) {
    return { status: "red", detail: `last result is ${ageH.toFixed(0)}h old (limit ${A_LOG_MAX_AGE_H}h): ${said}` };
  }
  return { status: last.startsWith("GREEN") ? "green" : "red", detail: `${said} (${ageH.toFixed(0)}h ago)` };
}

/** One IST calendar day as UTC instants. offsetDays 0 = the IST day containing nowMs, -1 = the day before. */
export function istDayWindow(nowMs: number, offsetDays: number): { start: string; end: string } {
  const istMidnight = Math.floor((nowMs + IST_OFFSET_MS) / 86_400_000) * 86_400_000 - IST_OFFSET_MS;
  const start = istMidnight + offsetDays * 86_400_000;
  return { start: new Date(start).toISOString(), end: new Date(start + 86_400_000).toISOString() };
}
