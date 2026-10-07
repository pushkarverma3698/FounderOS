/**
 * FounderOS v3 kernel — number check (AG-034). LOG ONLY.
 * ====================================================
 * 2026-09-06 (#297) "95% of candidates" and 2026-10-04 (#522) "11 automated commits in 72
 * hours": no step result held either number, and the live judge passed both. A
 * percentage, or a count above 10, that is in no step output and not in the founder
 * message is reported here. Nothing is rewritten: enforcement is a later decision,
 * made on a week of claim_check.number lines.
 */

import type { StepResult } from "./contracts.js";

/** Counts at or below this are ignored: "3 PRs" is too common to be a statistic. */
const MIN_COUNT = 11;

/** Thousands-grouped or plain integer, optional decimals, optional percent sign. Skips "#762" and digits inside words. */
const NUMBER = /(?<![#\w.,])(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(\s?%)?/g;

const stripCommas = (s: string): string => s.replace(/(\d),(?=\d{3}(?!\d))/g, "$1");

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function supportedBy(haystack: string, value: string): boolean {
  return new RegExp("(?<![\\d.])" + escapeRegExp(value) + "(?!\\d|\\.\\d)").test(haystack);
}

/**
 * Percentages and counts above 10 in `reply` that appear neither in a step result
 * output nor in the founder message. Each is returned once, in order of appearance;
 * a percentage is returned with its sign ("95%"), a count as digits ("11").
 */
export function findUnsupportedNumbers(
  reply: string,
  results: readonly StepResult[],
  founderMessage: string,
): string[] {
  const outputs = results.map((r) => (r.status === "ok" ? JSON.stringify(r.output ?? null) : ""));
  const haystack = stripCommas([...outputs, founderMessage].join("\n"));
  const found: string[] = [];
  for (const m of reply.matchAll(NUMBER)) {
    const value = stripCommas(m[1]!) + (m[2] ?? "");
    const isPercent = m[3] !== undefined;
    if (!isPercent && (m[2] !== undefined || Number(value) < MIN_COUNT)) continue;
    const label = isPercent ? value + "%" : value;
    if (!found.includes(label) && !supportedBy(haystack, value)) found.push(label);
  }
  return found;
}
