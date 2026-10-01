/**
 * FounderOS — goals: numbers in and out
 * =====================================
 * Postgres `numeric` reaches drizzle as a string, and one NaN silently poisons every
 * comparison after it (STANDARDS §4: parse with Number() AND check isFinite). Three
 * jobs live here and nowhere else:
 *   parseNumeric     a stored value  → a finite number, or null
 *   parseUserNumber  what the founder typed after `target=` / `/goal <n>` → finite, or null
 *   formatNumber     a number → what the standup prints (never exponent notation)
 */

/** Largest target or value the commands accept: counts and money sit far inside JS's exact-integer range. */
export const MAX_GOAL_VALUE = 1e15;

/** The only characters a decimal literal (with optional sign and exponent) may contain. */
const NUMERIC_CHARS: ReadonlySet<string> = new Set("0123456789+-.eE");

/**
 * A stored `numeric` (string) or number → a finite number; null for anything else.
 *
 * The character screen is deliberate: `Number("0x10")` is 16 and `Number("Infinity")` is
 * Infinity, and a value read back from a database column must never be either.
 */
export function parseNumeric(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (text.length === 0) return null;
  for (const ch of text) if (!NUMERIC_CHARS.has(ch)) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

const isDigits = (s: string | undefined): boolean => s !== undefined && s.length > 0 && [...s].every((c) => c >= "0" && c <= "9");

/**
 * What the founder typed → a finite number, or null. Strict on purpose: plain decimals
 * only (`5`, `0`, `2.5`, `-4`). No exponents, thousands separators or leading `+`, so
 * "1,000" or "1e3" is a question ("did you mean 1000?"), never a guess.
 */
export function parseUserNumber(text: string): number | null {
  const unsigned = text.startsWith("-") ? text.slice(1) : text;
  const [whole, fraction, extra] = unsigned.split(".");
  if (extra !== undefined || !isDigits(whole)) return null;
  if (fraction !== undefined && !isDigits(fraction)) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

const GROUPED = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const SMALL = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 2 });

/**
 * "5", "2.5", "12,000", "1,000,000,000,000,000,000,000". Two fraction digits at most, and
 * a small non-zero value keeps its first significant digits rather than printing a 0 that
 * would read as "nothing happened".
 */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return "?";
  if (n === 0) return "0";
  const grouped = GROUPED.format(n);
  return grouped === "0" || grouped === "-0" ? SMALL.format(n) : grouped;
}
