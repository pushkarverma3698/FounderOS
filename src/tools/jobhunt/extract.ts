/**
 * Posting fact extraction
 * =======================
 * Pure text → typed facts. No I/O, no model, no network.
 *
 * This module exists because the previous design let the LLM supply the salary
 * numbers the salary gate then screened. That put a hallucination surface in the
 * middle of a legal check, and it fails in a specific, catastrophic way: Dutch
 * writes "€4.500" for four and a half thousand, so a model reading that dot as a
 * decimal separator yields 4.5 and the entire market is rejected as sub-floor.
 *
 * THE FAILURE-DIRECTION RULE, which decides every judgement call below:
 * being too permissive costs a wasted application, which is visible; being too
 * strict silently discards a real opportunity, which is not. So when a value
 * cannot be read with confidence this returns "unstated" rather than a guess — a
 * wrong number produces a confident wrong verdict, an absent one produces a flag
 * a human resolves.
 */

export type SalaryUnit = "annual" | "monthly" | "hourly" | "none";
export type HolidayBasis = "included" | "excluded" | "unstated";
export type DutchRequired = "yes" | "no" | "unstated";
export type PostingRoute = "hsm" | "remote-contract" | "unclear";

export interface SalaryFacts {
  readonly min?: number;
  readonly max?: number;
  readonly unit: SalaryUnit;
  /** True when the unit was inferred from magnitude rather than stated. */
  readonly unitInferred: boolean;
  readonly holidayBasis: HolidayBasis;
  /** <1 when the posting advertises part-time hours. */
  readonly fteFactor?: number;
  /** The matched substring, so evidence can quote the posting. */
  readonly raw?: string;
}

export interface LanguageFacts {
  readonly dutchRequired: DutchRequired;
  readonly evidence: string;
}

export interface PostingFacts {
  readonly salary: SalaryFacts;
  readonly language: LanguageFacts;
  readonly route: PostingRoute;
}

/** Plausible magnitude bands per unit — the disambiguator for European separators. */
const PLAUSIBLE: Record<Exclude<SalaryUnit, "none">, readonly [number, number]> = {
  hourly: [10, 300],
  monthly: [1_000, 30_000],
  annual: [15_000, 500_000],
};

const FULL_TIME_HOURS = 40;

function isPlausible(value: number, unit: Exclude<SalaryUnit, "none">): boolean {
  const [lo, hi] = PLAUSIBLE[unit];
  return value >= lo && value <= hi;
}

/**
 * Parse one European-or-English money token into a number.
 *
 * The hard case is a lone separator followed by exactly three digits: "55.000"
 * and "55,000" are both 55000 in their respective conventions, while "4,50" is
 * four-fifty. Resolved by digit count, then by salary-magnitude plausibility —
 * never by assuming a locale, because Dutch postings written in English mix both.
 *
 * Returns null when the token cannot be read confidently.
 */
export function parseAmount(token: string): number | null {
  const cleaned = token
    .replace(/[€\s]/g, "")
    .replace(/,-$/, "")
    .trim()
    // A trailing separator is sentence punctuation, never part of the number.
    // Observed live 2026-07-29: a posting ending "…€2,95." parsed as 295 —
    // the trailing full stop made the comma look like a thousands mark — which
    // became €613,600/year at full-time hours and PASSED the salary gate. A
    // false pass is the expensive direction: it spends a real application.
    .replace(/[.,]+$/, "");
  if (cleaned.length === 0) return null;

  const kSuffix = /^([\d.,]+)[kK]$/.exec(cleaned);
  if (kSuffix) {
    const base = parseAmount(kSuffix[1]!);
    return base === null ? null : base * 1000;
  }

  if (!/^[\d.,]+$/.test(cleaned)) return null;

  const dots = (cleaned.match(/\./g) ?? []).length;
  const commas = (cleaned.match(/,/g) ?? []).length;

  // Both separators present: the LAST one is the decimal mark.
  if (dots > 0 && commas > 0) {
    const lastDot = cleaned.lastIndexOf(".");
    const lastComma = cleaned.lastIndexOf(",");
    const decimalMark = lastDot > lastComma ? "." : ",";
    const thousandsMark = decimalMark === "." ? "," : ".";
    const normalised = cleaned.split(thousandsMark).join("").replace(decimalMark, ".");
    const value = Number(normalised);
    return Number.isFinite(value) ? value : null;
  }

  // Multiple of the same separator can only be thousands grouping: 1.234.567
  if (dots > 1 || commas > 1) {
    const value = Number(cleaned.replace(/[.,]/g, ""));
    return Number.isFinite(value) ? value : null;
  }

  // Exactly one separator — the genuinely ambiguous case.
  if (dots === 1 || commas === 1) {
    const sep = dots === 1 ? "." : ",";
    const [head, tail] = cleaned.split(sep) as [string, string];

    // Three trailing digits reads as thousands grouping in both conventions.
    if (tail.length === 3) {
      const asThousands = Number(head + tail);
      const asDecimal = Number(`${head}.${tail}`);
      const thousandsPlausible = (["annual", "monthly", "hourly"] as const).some((u) =>
        isPlausible(asThousands, u),
      );
      const decimalPlausible = (["annual", "monthly", "hourly"] as const).some((u) =>
        isPlausible(asDecimal, u),
      );
      // Only when BOTH readings are plausible is this genuinely unreadable.
      if (thousandsPlausible && !decimalPlausible) return asThousands;
      if (decimalPlausible && !thousandsPlausible) return asDecimal;
      return thousandsPlausible ? asThousands : null;
    }

    const value = Number(`${head}.${tail}`);
    return Number.isFinite(value) ? value : null;
  }

  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

const UNIT_PATTERNS: ReadonlyArray<readonly [RegExp, Exclude<SalaryUnit, "none">]> = [
  [/\b(per\s*maand|p\/?m\b|per\s*month|monthly|maandelijks|\/\s*m(?:nd|aand)\b|bruto\s*per\s*maand)/i, "monthly"],
  [/\b(per\s*jaar|p\/?j\b|per\s*year|per\s*annum|annually|annual|jaarlijks|\/\s*(?:jr|yr|year))/i, "annual"],
  [/\b(per\s*uur|p\/?u\b|per\s*hour|hourly|hr\b|\/\s*(?:uur|hour|hr))/i, "hourly"],
];

const MONEY_TOKEN = String.raw`€\s*[\d][\d.,]*\s*[kK]?|[\d][\d.,]*\s*[kK]\b`;
const RANGE_SEP = String.raw`\s*(?:-|–|—|tot(?:\s+en\s+met)?|to|t\/m)\s*`;

/** Detect the stated unit near a match, or infer it from magnitude. */
function resolveUnit(context: string, sample: number): { unit: SalaryUnit; inferred: boolean } {
  for (const [re, unit] of UNIT_PATTERNS) {
    if (re.test(context)) return { unit, inferred: false };
  }
  // Nothing stated — infer, but only when exactly one band is plausible.
  const fits = (["hourly", "monthly", "annual"] as const).filter((u) => isPlausible(sample, u));
  if (fits.length === 1) return { unit: fits[0]!, inferred: true };
  return { unit: "none", inferred: true };
}

const HOLIDAY_TERM = String.raw`(?:vakantiegeld|vakantietoeslag|holiday\s*(?:allowance|pay))`;

/**
 * The gap between the qualifier and the term deliberately excludes sentence
 * punctuation, so "excl. bonus. Holiday pay is included" cannot be read as one
 * statement — except for the abbreviation dot in "incl."/"excl.", which is
 * matched explicitly. A wrongly-detected basis is worse than an unstated one:
 * `unstated` enumerates both readings and only involves a human when it matters,
 * whereas a wrong `included` silently deflates the figure by 8% and can reject a
 * role that was fine.
 */
const qualifier = (stems: string) =>
  new RegExp(String.raw`\b(?:${stems})\b\.?\s{0,3}(?:\d{1,2}\s*%\s*)?[^.;\n]{0,30}${HOLIDAY_TERM}`, "i");

const INCL = qualifier("incl|inclusief|including|includes|included|inclusive");
const EXCL = qualifier("excl|exclusief|excluding|excludes|excluded|exclusive of");

function resolveHolidayBasis(text: string): HolidayBasis {
  if (EXCL.test(text)) return "excluded";
  if (INCL.test(text)) return "included";
  return "unstated";
}

/**
 * Advertised working hours as a fraction of full time.
 * Only returns a value below 1 — a full-time posting needs no adjustment, and
 * reporting 1.0 everywhere would add noise to every evidence string.
 */
export function extractFteFactor(text: string): number | undefined {
  const fte = /(\d(?:[.,]\d+)?)\s*(?:fte|f\.t\.e\.)/i.exec(text);
  if (fte) {
    const value = Number(fte[1]!.replace(",", "."));
    if (value > 0 && value < 1) return value;
    if (value >= 1) return undefined;
  }

  const hours = /(\d{2})\s*(?:uur|hours?|u\.)\s*(?:per\s*week|p\/?w|\/\s*week|per\s*wk)?/i.exec(text);
  if (hours) {
    const h = Number(hours[1]!);
    if (h > 0 && h < FULL_TIME_HOURS) return h / FULL_TIME_HOURS;
    return undefined;
  }

  if (/\b(?:4|four|vier)[\s-]*(?:day|daagse|dagen)\b/i.test(text)) return 0.8;
  return undefined;
}

/**
 * US retirement-plan names that are a NUMBER followed by a letter, and are not
 * money: 401(k), 401k, 403(b), 457(b).
 *
 * `MONEY_TOKEN` accepts a bare `\d+k` with no currency symbol, because Dutch and
 * English postings both write "70k" for a salary. "401k" fits that shape
 * exactly, parses as 401 × 1000, and 401,000 is a plausible annual figure — so a
 * US posting listing its benefits was read as advertising a €401,000 salary.
 * Three of the six roles in the first APPLY TODAY section built from real data
 * (dev DB, 2026-08-01) carried that number, each one a confident claim about pay
 * that the posting never made.
 *
 * The failure direction is the expensive one: a fabricated figure PASSES the
 * salary gate. A missing figure only flags, which asks a human. So these are
 * masked out of the text before any money match runs.
 */
const RETIREMENT_PLAN_RE = /\b40[13]\s*\(?\s*[kb]\s*\)?|\b457\s*\(?\s*b\s*\)?/gi;

/** Blank a non-salary numeric idiom, preserving length so match offsets hold. */
function maskNonSalaryNumbers(text: string): string {
  return text.replace(RETIREMENT_PLAN_RE, (m) => " ".repeat(m.length));
}

/** Pull the salary range and its qualifiers out of the posting text. */
export function extractSalary(raw: string): SalaryFacts {
  const holidayBasis = resolveHolidayBasis(raw);
  const fteFactor = extractFteFactor(raw);
  const base = { holidayBasis, ...(fteFactor !== undefined ? { fteFactor } : {}) };

  // Masked AFTER the qualifier and FTE reads, which do not look at money, and
  // length-preserving so every offset below still indexes the original text.
  const text = maskNonSalaryNumbers(raw);

  const rangeRe = new RegExp(`(${MONEY_TOKEN})${RANGE_SEP}(${MONEY_TOKEN})`, "i");
  const range = rangeRe.exec(text);
  if (range) {
    const min = parseAmount(range[1]!);
    const max = parseAmount(range[2]!);
    if (min !== null && max !== null && min <= max) {
      const context = text.slice(range.index, range.index + range[0].length + 40);
      const { unit, inferred } = resolveUnit(context, max);
      return { ...base, min, max, unit, unitInferred: inferred, raw: range[0].trim() };
    }
  }

  const singleRe = new RegExp(`(${MONEY_TOKEN})`, "i");
  const single = singleRe.exec(text);
  if (single) {
    const value = parseAmount(single[1]!);
    if (value !== null) {
      const context = text.slice(single.index, single.index + single[0].length + 40);
      const { unit, inferred } = resolveUnit(context, value);
      return { ...base, max: value, unit, unitInferred: inferred, raw: single[0].trim() };
    }
  }

  return { ...base, unit: "none", unitInferred: false };
}

/**
 * Dutch-language requirement, in either language.
 *
 * The English-only predecessor passed "Nederlands is vereist" — every hard Dutch
 * requirement phrased in Dutch, which is most of them.
 *
 * Scoped per SENTENCE, and only sentences that are actually about language count.
 * "We are a Dutch company in the Dutch market" mentions Dutch three times and
 * requires it zero times; treating that as an unresolved requirement would put a
 * large share of the market into the founder's queue for nothing.
 */
const DUTCH_MENTION = /\b(dutch|nederlands|nederlandse|nederlandstalig)\b/i;
const LANGUAGE_CONTEXT =
  /\b(language|languages|taal|talen|spreek\w*|spoken|speak\w*|fluen\w*|vloeiend|beheersing|moedertaal|native|bilingual|tweetalig|communicat\w*|schrijf\w*|written|writing|verbal|mondeling)\b/i;
const SOFTENER =
  /\b(nice to have|a plus|pluspunt|pré|pre|preferred|preference|advantage|voordeel|bonus|desirable|wenselijk|helpful|niet vereist|not required)\b/i;
const HARD_REQUIREMENT =
  /\b(required|require[sd]?|requirement|fluent|fluency|native|mandatory|must|essential|vereist|verplicht|vloeiend|beheersing|moedertaal|noodzakelijk|nodig)\b/i;

/** Words between the nearest Dutch mention and the nearest match of `re`, or null. */
function tokenDistance(sentence: string, re: RegExp): number | null {
  const words = sentence.split(/\s+/);
  const dutchAt: number[] = [];
  const otherAt: number[] = [];
  words.forEach((w, i) => {
    if (DUTCH_MENTION.test(w)) dutchAt.push(i);
    if (re.test(w)) otherAt.push(i);
  });
  if (dutchAt.length === 0 || otherAt.length === 0) return null;
  return Math.min(...dutchAt.flatMap((d) => otherAt.map((o) => Math.abs(d - o))));
}

/**
 * How close a requirement word must sit to the Dutch mention to be read as a
 * requirement OF Dutch.
 *
 * "Nederlands is vereist" carries no separate language word — in Dutch the
 * language noun IS the mention — so a context-word test alone misses the most
 * common phrasing entirely. Proximity catches it. The window stays tight because
 * "a Dutch company where Python experience is required" must NOT read as a Dutch
 * requirement: that misread rejects a good role, which is the silent direction.
 */
const REQUIREMENT_PROXIMITY_WORDS = 4;

export function extractLanguage(text: string): LanguageFacts {
  const sentences = text.split(/(?<=[.;!?\n])\s*/).filter((s) => s.trim().length > 0);
  const relevant = sentences.filter((s) => {
    if (!DUTCH_MENTION.test(s)) return false;
    if (LANGUAGE_CONTEXT.test(s)) return true;
    const d = tokenDistance(s, HARD_REQUIREMENT);
    return d !== null && d <= REQUIREMENT_PROXIMITY_WORDS;
  });

  if (relevant.length === 0) {
    return { dutchRequired: "no", evidence: "No Dutch-language requirement mentioned." };
  }

  // A softener anywhere in a language sentence settles it: "Dutch is a plus"
  // cannot also be a bar, and this reading errs toward keeping the role in play.
  const softened = relevant.find((s) => SOFTENER.test(s));
  if (softened) {
    return {
      dutchRequired: "no",
      evidence: `Dutch is a preference, not a requirement: "${softened.trim().slice(0, 120)}"`,
    };
  }

  const demanded = relevant.find((s) => HARD_REQUIREMENT.test(s));
  if (demanded) {
    return {
      dutchRequired: "yes",
      evidence: `Posting requires Dutch — not attainable within the hiring window: "${demanded.trim().slice(0, 120)}"`,
    };
  }

  return {
    dutchRequired: "unstated",
    evidence: `Dutch discussed without a clear requirement or softener: "${relevant[0]!.trim().slice(0, 120)}"`,
  };
}

const REMOTE_MARKER =
  /\b(fully remote|remote[- ]first|work from anywhere|100%\s*remote|freelance|freelancer|zzp|contractor|contracting|b2b|interim|detachering|zelfstandige)\b/i;
const ONSITE_MARKER =
  /\b(on[- ]?site|onsite|hybrid|hybride|relocation|relocate|visa sponsorship|sponsorship available|highly skilled migrant|kennismigrant|office[- ]based)\b/i;

/**
 * Which permit route a posting belongs to.
 *
 * `unclear` is a real answer, not a failure: the caller screens an unclear
 * posting under BOTH routes and passes if either passes, because guessing wrong
 * in either direction loses something — guessing "remote" skips the sponsor gate
 * and wastes an application, guessing "hsm" applies a sponsor gate that does not
 * apply and silently drops the highest-value channel.
 */
export function extractRoute(text: string): PostingRoute {
  const remote = REMOTE_MARKER.test(text);
  const onsite = ONSITE_MARKER.test(text);
  if (remote && !onsite) return "remote-contract";
  if (onsite && !remote) return "hsm";
  return "unclear";
}

export function extractPostingFacts(text: string): PostingFacts {
  return {
    salary: extractSalary(text),
    language: extractLanguage(text),
    route: extractRoute(text),
  };
}
