/**
 * FounderOS — goals: what a metric argument or an echoed id may look like
 * =======================================================================
 * A metric argument (`wife-nl-finance`, `owner/repo`, `linkedin_post`) ends up inside a GitHub
 * search query and inside strings that feed an LLM prompt. So it is a plain id or nothing:
 * letters, digits and `_ - . /`. No spaces, colons or quotes means it cannot carry a second
 * search qualifier or a second instruction. Char sets, not regex, on purpose: nothing here is
 * routing, and a set is trivially auditable.
 */

/** Longest argument accepted. A repo slug is at most 39 + 1 + 100 on GitHub; this is generous and bounded. */
export const MAX_TOKEN_CHARS = 100;

const TOKEN_CHARS: ReadonlySet<string> = new Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-./");
const IDENT_CHARS: ReadonlySet<string> = new Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_");

/** True for a plain id: safe to put in a search query, a log line, and a model prompt. */
export function isSafeToken(text: string): boolean {
  return text.length > 0 && text.length <= MAX_TOKEN_CHARS && [...text].every((c) => TOKEN_CHARS.has(c));
}

/** True for a bare identifier (an error class name): letters, digits, underscore, at most 40 chars. */
export function isIdentifier(text: string): boolean {
  return text.length > 0 && text.length <= 40 && [...text].every((c) => IDENT_CHARS.has(c));
}

/** True for `owner/repo` where both halves are plain ids: the only shape a repo argument may take. */
export function isRepoSlug(text: string): boolean {
  if (!isSafeToken(text)) return false;
  const parts = text.split("/");
  return parts.length === 2 && parts.every((p) => p.length > 0 && p !== "." && p !== "..");
}
