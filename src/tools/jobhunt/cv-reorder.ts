/**
 * Reorder a CV so the posting's matched keywords come first (pure, no model, $0)
 * ==============================================================================
 * ONLY reorders. Skill items inside a skills line and bullets inside one bullet block (one role) change place;
 * nothing is added, dropped or reworded, so the set of bullets and skills is identical before and after.
 * `sameContent` is the guard that proves it, and `reorderForPosting` returns its input when the guard fails.
 */

import { extractSkillTerms } from "./skills.js";

const SKILLS_HEADING_RE = /^#{1,3}\s*(technical skills|skills|core skills|key skills|technologies|tech stack|competenc\w*)\b/i;
const HEADING_RE = /^#{1,3}\s+\S/;
const BULLET_RE = /^\s*[-*]\s+/;

/** How many of the matched terms a piece of text names. */
function hits(text: string, matched: ReadonlySet<string>, dict: string): number {
  return extractSkillTerms(text, dict).filter((s) => matched.has(s.term)).length;
}

/** Stable sort, most hits first. Equal hits keep their original order. */
function stableByHits<T>(items: readonly T[], score: (t: T) => number): T[] {
  return items
    .map((item, i) => ({ item, i, s: score(item) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.item);
}

/** Split on commas outside parentheses, so "Python (FastAPI, Django)" stays one item. */
function splitItems(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(" || ch === "[") depth++;
    if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function reorderSkillLine(line: string, matched: ReadonlySet<string>, dict: string): string {
  const m = /^(\s*(?:[-*]\s+)?(?:\*\*[^*]+\*\*\s*:?\s*|[^:,]{1,40}:\s*))?(.*)$/.exec(line);
  const prefix = m?.[1] ?? "";
  const rest = m?.[2] ?? line;
  const items = splitItems(rest);
  if (items.length < 2) return line;
  const sorted = stableByHits(items, (it) => hits(it, matched, dict));
  // Keep the single space after each comma the original used: re-trim, then join the same way.
  return `${prefix}${sorted.map((s) => s.trim()).join(", ")}`;
}

/** Bullet blocks are runs of bullet lines; an indented continuation line travels with its bullet. */
function reorderBulletBlock(lines: string[], matched: ReadonlySet<string>, dict: string): string[] {
  const bullets: string[][] = [];
  for (const l of lines) {
    if (BULLET_RE.test(l) || bullets.length === 0) bullets.push([l]);
    else bullets[bullets.length - 1]!.push(l);
  }
  return stableByHits(bullets, (b) => hits(b.join(" "), matched, dict)).flat();
}

export function reorderForPosting(markdown: string, matchedTerms: readonly string[], dict = "tech"): string {
  const matched = new Set(matchedTerms);
  if (matched.size === 0) return markdown;
  const lines = markdown.split("\n");
  const out: string[] = [];
  let inSkills = false;
  let block: string[] = [];
  const flush = (): void => {
    if (block.length) out.push(...reorderBulletBlock(block, matched, dict));
    block = [];
  };
  for (const line of lines) {
    if (HEADING_RE.test(line)) {
      flush();
      inSkills = SKILLS_HEADING_RE.test(line);
      out.push(line);
    } else if (inSkills) {
      out.push(line.trim() ? reorderSkillLine(line, matched, dict) : line);
    } else if (BULLET_RE.test(line) || (block.length > 0 && /^\s+\S/.test(line))) {
      block.push(line);
    } else {
      flush();
      out.push(line);
    }
  }
  flush();
  const result = out.join("\n");
  return sameContent(markdown, result) ? result : markdown;
}

/** The multiset of lines, and of skill items inside skills sections, ignoring order. */
function contentKey(markdown: string): string[] {
  const keys: string[] = [];
  let inSkills = false;
  for (const raw of markdown.split("\n")) {
    if (HEADING_RE.test(raw)) inSkills = SKILLS_HEADING_RE.test(raw);
    if (inSkills && !HEADING_RE.test(raw)) {
      const body = raw.replace(/^(\s*(?:[-*]\s+)?(?:\*\*[^*]+\*\*\s*:?\s*|[^:,]{1,40}:\s*))?/, "");
      for (const item of splitItems(body)) if (item.trim()) keys.push(`skill:${item.trim()}`);
    } else if (raw.trim()) keys.push(`line:${raw.trim()}`);
  }
  return keys.sort();
}

export function sameContent(before: string, after: string): boolean {
  const a = contentKey(before);
  const b = contentKey(after);
  return a.length === b.length && a.every((k, i) => k === b[i]);
}
