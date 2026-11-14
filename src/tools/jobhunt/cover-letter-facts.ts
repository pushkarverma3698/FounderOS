/**
 * FounderOS — the cover letter fact check
 * =======================================
 * Letters are attached to applications without a human reading them first, so a
 * wrong fact has to be blocked by code, not by prompt wording. Seen on prod
 * 2026-11-14: "I can start immediately and am relocating to the Netherlands" on
 * a Bengaluru role, "operated one for over a year" in a letter that dated the
 * system to June 2026, and a test count that drifted from the real one.
 *
 * Pure: no I/O, no model. `checkLetterFacts` lists violations; `removeSentences`
 * and `readsWhole` let the caller drop the offending sentences when what is left
 * still reads as a letter.
 */

export type FactRule = "relocation" | "availability" | "number" | "duration" | "permit";

export interface FactViolation {
  readonly rule: FactRule;
  readonly sentence: string;
  readonly detail: string;
}

export interface LetterFactContext {
  /** Where the posting is: NL | IN | other | unknown (the row's `country`). */
  readonly postingCountry?: string;
  /** CV, dossier and founder context: the only places a number or a place may come from. */
  readonly sourceText: string;
  /** Company and role names, whose digits are not claims. */
  readonly exemptText?: string;
  /** The stored notice period, if any. */
  readonly notice?: { readonly days?: number; readonly detail?: string };
  readonly now?: Date;
}

const PLACES: ReadonlyArray<readonly [string, string]> = [
  ["NL", "netherlands|holland|amsterdam|rotterdam|utrecht|eindhoven|the hague|den haag|dutch"],
  ["IN", "india|bengaluru|bangalore|mumbai|delhi|pune|hyderabad|chennai|himachal"],
  ["DE", "germany|berlin|munich"],
  ["BE", "belgium|brussels"],
  ["GB", "united kingdom|uk|england|london"],
  ["IE", "ireland|dublin"],
  ["FR", "france|paris"],
  ["US", "united states|usa"],
];
const PLACE_RES = PLACES.map(([code, names]) => [code, new RegExp(`\\b(?:${names})\\b`, "i")] as const);

const RELOCATE = /\brelocat\w*/i;
const MOVE_TO = /\b(?:mov(?:e|es|ed|ing)|settl(?:e|es|ed|ing))\s+(?:permanently\s+)?(?:to|into)\b/i;
const BASED_IN = /\b(?:based|located|living|lives?|residing|resides?|resident)\s+in\b/i;
const START_CLAIM =
  /\b(?:can|could|able to|ready to|available to)\s+start\b|\bavailable\s+(?:immediately|from|starting|as of|in|on|after)\b|\bstart(?:ing)?\s+(?:date|on|from)\b|\bnotice period\b/i;
const IMMEDIATE = /\bimmediate(?:ly)?\b|\bright away\b|\bstraight away\b|\bat once\b/i;
const PERMIT =
  /\b(?:work|residence|residency|stay|partner|highly skilled|orientation year|job seeker)\s+(?:permit|visa)s?\b|\bvisas?\b|\bsponsorship\b|\bright to work\b|\bwork rights\b|\bwork authori[sz]ation\b|\bblue card\b|\bhighly skilled migrant\b|\bIND\b/i;

const WORD_NUMBERS: Readonly<Record<string, number>> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};
const DURATION = new RegExp(
  `(?<!\\b(?:times|once|twice|per)\\s)\\b(?:(over|more than|nearly|almost|about|around|roughly)\\s+)?(${Object.keys(WORD_NUMBERS).join("|")}|\\d+(?:\\.\\d+)?)[\\s-]+(year|month)s?\\b`,
  "gi",
);
const NUMBER = /\b\d[\d,]*(?:\.\d+)?(?:\s?%|k\b|m\b|x\b)?/gi;
const MONTHS = "jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec";
const DATE = new RegExp(`\\b(${MONTHS})[a-z]*\\.?\\s+((?:19|20)\\d\\d)\\b|\\bsince\\s+((?:19|20)\\d\\d)\\b`, "gi");

/** Sentences, with the salutation and sign-off lines kept as their own units. */
export function splitSentences(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .flatMap((p) => p.split(/(?<=[.!?])\s+(?=[A-Z"(])/))
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 0);
}

function placeCodes(sentence: string): string[] {
  return PLACE_RES.filter(([, re]) => re.test(sentence)).map(([code]) => code);
}

type PlaceKind = "relocation" | "based";
function placeKind(sentence: string): PlaceKind | null {
  if (RELOCATE.test(sentence) || MOVE_TO.test(sentence)) return "relocation";
  if (BASED_IN.test(sentence) && placeCodes(sentence).length > 0) return "based";
  return null;
}

function supportedPlaces(source: string, kind: PlaceKind): Set<string> {
  const out = new Set<string>();
  for (const s of splitSentences(source)) if (placeKind(s) === kind) placeCodes(s).forEach((c) => out.add(c));
  return out;
}

function durationKey(n: number, unit: string): string {
  return `${n}${unit.toLowerCase().startsWith("y") ? "y" : "m"}`;
}

function durationsIn(text: string): Array<{ readonly key: string; readonly months: number }> {
  return [...text.matchAll(DURATION)].map((m) => {
    const raw = (m[2] ?? "").toLowerCase();
    const n = WORD_NUMBERS[raw] ?? Number(raw);
    return { key: durationKey(n, m[3] ?? ""), months: (m[3] ?? "").toLowerCase() === "year" ? n * 12 : n };
  });
}

function numberKeys(text: string): Set<string> {
  return new Set([...text.matchAll(NUMBER)].map((m) => m[0].replace(/[,\s]/g, "").toLowerCase()));
}

function isYear(key: string): boolean {
  return /^(?:19|20)\d\d$/.test(key);
}

function earliestPastDate(letter: string, now: Date): { readonly label: string; readonly months: number } | null {
  let best: { label: string; months: number } | null = null;
  for (const m of letter.matchAll(DATE)) {
    const monthIdx = m[1] ? MONTHS.split("|").indexOf(m[1].toLowerCase().slice(0, 3)) : 0;
    const year = Number(m[2] ?? m[3]);
    const months = (now.getUTCFullYear() - year) * 12 + (now.getUTCMonth() - monthIdx);
    if (months < 0) continue;
    if (!best || months > best.months) best = { label: m[0], months };
  }
  return best;
}

function noticeText(notice: LetterFactContext["notice"]): string {
  if (!notice) return "";
  return [notice.detail ?? "", notice.days !== undefined ? String(notice.days) : ""].join(" ").trim();
}

function noticeIsImmediate(notice: NonNullable<LetterFactContext["notice"]>): boolean {
  return notice.days === 0 || IMMEDIATE.test(notice.detail ?? "");
}

function checkPlace(sentence: string, ctx: LetterFactContext): FactViolation | null {
  const kind = placeKind(sentence);
  if (!kind) return null;
  const codes = placeCodes(sentence);
  const posting = ctx.postingCountry ?? "unknown";
  const supported = supportedPlaces(ctx.sourceText, kind);
  const what = kind === "relocation" ? "relocation" : "location";
  if (codes.length === 0) return { rule: "relocation", sentence, detail: `${what} claim with no place the profile supports` };
  const wrong = codes.find((c) => c !== posting);
  if (wrong) return { rule: "relocation", sentence, detail: `${what} claim names ${wrong} but the posting country is ${posting}` };
  if (!codes.every((c) => supported.has(c))) return { rule: "relocation", sentence, detail: `${what} claim is not in the profile or dossier` };
  return null;
}

function checkAvailability(sentence: string, ctx: LetterFactContext): FactViolation | null {
  if (!START_CLAIM.test(sentence)) return null;
  const notice = ctx.notice;
  const stored = noticeText(notice);
  if (!notice || stored === "") return { rule: "availability", sentence, detail: "start claim but no notice period is stored" };
  if (IMMEDIATE.test(sentence)) {
    return noticeIsImmediate(notice) ? null : { rule: "availability", sentence, detail: `claims immediate start but the stored notice is "${stored}"` };
  }
  const tokens = [...sentence.matchAll(new RegExp(`\\d+|${MONTHS}[a-z]*`, "gi"))].map((m) => m[0].toLowerCase());
  const haystack = stored.toLowerCase();
  const missing = tokens.find((t) => !haystack.includes(t.slice(0, 3)) && !haystack.includes(t));
  return missing ? { rule: "availability", sentence, detail: `"${missing}" does not match the stored notice "${stored}"` } : null;
}

function checkNumbers(sentence: string, letter: string, ctx: LetterFactContext, source: Set<string>, sourceDurations: Set<string>): FactViolation[] {
  const now = ctx.now ?? new Date();
  const out: FactViolation[] = [];
  const exempt = numberKeys(ctx.exemptText ?? "");
  for (const d of durationsIn(sentence)) {
    if (!sourceDurations.has(d.key)) out.push({ rule: "duration", sentence, detail: `"${d.key}" duration is not in the CV or dossier` });
  }
  const dated = earliestPastDate(letter, now);
  if (dated) {
    for (const d of durationsIn(sentence)) {
      if (d.months > dated.months + 1) out.push({ rule: "duration", sentence, detail: `claims ${d.months} months but the letter dates it to ${dated.label} (${dated.months} months ago)` });
    }
  }
  const withoutDurations = sentence.replace(DURATION, " ");
  for (const m of withoutDurations.matchAll(NUMBER)) {
    const key = m[0].replace(/[,\s]/g, "").toLowerCase();
    if (isYear(key) || exempt.has(key) || source.has(key)) continue;
    out.push({ rule: "number", sentence, detail: `"${m[0].trim()}" is not in the CV or dossier` });
  }
  return out;
}

/** Every rule violation in the letter, one entry per rule per sentence. */
export function checkLetterFacts(letter: string, ctx: LetterFactContext): FactViolation[] {
  const source = numberKeys(ctx.sourceText.replace(DURATION, " "));
  const sourceDurations = new Set(durationsIn(ctx.sourceText).map((d) => d.key));
  const out: FactViolation[] = [];
  for (const sentence of splitSentences(letter)) {
    if (/^dear\b/i.test(sentence)) continue;
    const found = [
      checkPlace(sentence, ctx),
      checkAvailability(sentence, ctx),
      ...(PERMIT.test(sentence) ? [{ rule: "permit" as const, sentence, detail: "permit, visa or sponsorship claims are never allowed" }] : []),
      ...checkNumbers(sentence, letter, ctx, source, sourceDurations),
    ];
    for (const v of found) if (v) out.push(v);
  }
  return out;
}

/** The letter with the given sentences taken out, paragraphs that empty out dropped. */
export function removeSentences(letter: string, drop: readonly string[]): string {
  const gone = new Set(drop);
  return letter
    .split(/\n{2,}/)
    .map((p) =>
      p
        .split(/(?<=[.!?])\s+(?=[A-Z"(])/)
        .map((s) => s.replace(/\s+/g, " ").trim())
        .filter((s) => s.length > 0 && !gone.has(s))
        .join(" "),
    )
    .filter((p) => p.length > 0)
    .join("\n\n");
}

/** Still a letter: at least three paragraphs and 600 characters. */
export function readsWhole(letter: string): boolean {
  return letter.split(/\n{2,}/).filter((p) => p.trim().length > 0).length >= 3 && letter.length >= 600;
}

/**
 * A letter that was not written in this run (an archived `/draft` letter): the same rules, no model.
 * Returns it with the offending sentences cut, or null when what is left is not a clean, whole letter.
 */
export function vetLetter(letter: string, ctx: LetterFactContext): string | null {
  const found = checkLetterFacts(letter, ctx);
  if (found.length === 0) return letter;
  const cut = removeSentences(letter, found.map((v) => v.sentence));
  return readsWhole(cut) && checkLetterFacts(cut, ctx).length === 0 ? cut : null;
}

/** One founder-facing line per violation. */
export function describeViolation(v: FactViolation): string {
  return `${v.rule}: ${v.detail} ("${v.sentence.length > 120 ? `${v.sentence.slice(0, 119)}…` : v.sentence}")`;
}
