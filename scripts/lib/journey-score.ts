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

export interface InboxMail {
  subject: string;
  /** The From header, "Name <addr>" or a bare address. */
  sender?: string;
}

/** Words too generic to prove a reply is about one particular mail. */
const GENERIC_SUBJECT_WORDS = new Set([
  "update", "updates", "fyi", "hello", "hi", "meeting", "reminder", "notification", "newsletter", "message", "email", "mail", "notes", "info",
]);
const MONTHS = new Set(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec"]);

/** The distinctive words of a subject: no re/fwd, no digits or month names (dates), no generic words, 3+ letters. */
export function subjectKeywords(subject: string): string[] {
  return normalize(subject)
    .replace(/^((re|fw|fwd|aw)\s+)+/, "")
    .split(" ")
    .filter((w) => w.length >= 3 && !/\d/.test(w) && !MONTHS.has(w) && !GENERIC_SUBJECT_WORDS.has(w));
}

/** The sender's display name ("Sandeep Bist" from `Sandeep Bist <s@x.com>`); undefined for a bare address. */
export function senderName(sender: string | undefined): string | undefined {
  const m = /^\s*"?([^"<@]+?)"?\s*<[^>]*>\s*$/.exec(sender ?? "");
  const n = m?.[1] ? normalize(m[1]) : "";
  return n.length >= 4 ? n : undefined;
}

/** How the reply points at this mail: its subject, its sender's name, or every distinctive word of its subject. */
function mentionedBy(reply: string, mail: InboxMail): string | undefined {
  if (names(reply, mail.subject)) return "subject";
  const padded = ` ${normalize(reply)} `;
  const who = senderName(mail.sender);
  if (who && padded.includes(` ${who} `)) return "sender";
  const words = subjectKeywords(mail.subject);
  if (words.length > 0 && words.every((w) => padded.includes(` ${w} `))) return "keywords";
  return undefined;
}

/**
 * J1: the reply is about at least one real mail from the last 24 h, or says nothing when gws found nothing.
 * The bot shortens and paraphrases subjects ("MoM | 8 Oct 2026" → "MoM from Sandeep Bist dated Oct 8"), so a mail
 * counts as named by its subject, its sender's display name, or all the distinctive words of its subject.
 */
export function scoreInbox(reply: string, mails: ReadonlyArray<string | InboxMail>): Verdict {
  if (mails.length === 0) {
    return saysNothing(reply)
      ? { ok: true, detail: "gws found no mail in the last 24 h and the bot said so" }
      : { ok: false, detail: "gws found no mail in the last 24 h but the bot did not say there was nothing" };
  }
  const list = mails.map((m): InboxMail => (typeof m === "string" ? { subject: m } : m));
  for (const mail of list) {
    const how = mentionedBy(reply, mail);
    if (how) return { ok: true, detail: `named "${mail.subject}" by its ${how} (one of ${list.length} real mails)` };
  }
  return { ok: false, detail: `named none of the ${list.length} real mails, e.g. ${quoteList(list.map((m) => m.subject))}` };
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

/** The colours a line of the reply speaks of. */
const colours = (line: string): string[] => Object.keys(VERDICT_WORDS).filter((k) => VERDICT_WORDS[k]!.test(line));

/**
 * The text that speaks for a PR line: the line itself plus, when replies group PRs ("**CI Red (3):**" then bullets),
 * the nearest heading above it. A heading names one colour or it is a summary ("9 green, 3 red") and says nothing.
 */
function contextFor(lines: readonly string[], index: number, anyPr: RegExp): string {
  const own = lines[index]!;
  for (let i = index - 1; i >= 0; i--) {
    const l = lines[i]!;
    if (l.trim() === "" || anyPr.test(l) || /^\s*([-*•]|\d+[.)])\s/.test(l) || l.trim().startsWith("|")) continue;
    return colours(l).length === 1 ? `${own} ${l}` : own;
  }
  return own;
}

/**
 * J3: every PR in the pre-ask GitHub snapshot is named with GitHub's CI verdict, and the follow-up names the oldest.
 * The list moves while the bot answers, so: PRs opened after the snapshot may appear in the reply freely, a snapshot PR
 * missing from `stillOpen` (closed or merged since) is skipped, and a snapshot PR whose CI was still pending may have
 * settled to any colour. `stillOpen` omitted = nothing closed.
 */
export function scorePrs(reply: string, followUp: string, prs: readonly OpenPr[], stillOpen?: ReadonlySet<number>): Verdict {
  const live = stillOpen ? prs.filter((p) => stillOpen.has(p.number)) : prs;
  if (live.length === 0) {
    return saysNothing(reply) || /\bno open\b/i.test(reply)
      ? { ok: true, detail: "no open PRs and the bot said so" }
      : { ok: false, detail: "GitHub has no open PRs but the bot did not say so" };
  }
  const problems: string[] = [];
  const lines = reply.split("\n");
  const anyPr = new RegExp(`(#|\\bPR\\s*#?)\\d{3,}\\b|\\|\\s*\\d{3,}\\s*\\|`, "i");
  for (const pr of live) {
    const ref = prRef(pr.number);
    const own = lines.map((l, i) => (ref.test(l) ? contextFor(lines, i, anyPr) : undefined)).filter((l): l is string => l !== undefined);
    if (own.length === 0) {
      problems.push(`#${pr.number} not named`);
      continue;
    }
    const words = pr.ci === "pending" ? undefined : VERDICT_WORDS[pr.ci];
    if (words && !own.some((l) => words.test(l))) problems.push(`#${pr.number}: GitHub says ${pr.ci}, the reply does not`);
  }
  const oldest = [...live].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0]!;
  if (!prRef(oldest.number).test(followUp)) problems.push(`follow-up did not name the oldest PR #${oldest.number}`);
  return problems.length === 0
    ? { ok: true, detail: `all ${live.length} open PRs and their CI verdicts match GitHub; follow-up named #${oldest.number}` }
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
