/**
 * FounderOS — the free sweep's failure summary
 * =============================================
 * Split out of free-ats-source.ts (LOC budget) when board ids and retirement reasons joined the
 * sweep result. Re-exported from free-ats-source.ts, so every existing import still works.
 */

/** Patterns beyond this are folded into a "+N more" tail rather than dropped. */
const SUMMARY_PATTERN_CAP = 6;

/**
 * Every failure in the sweep, as counts per (platform, reason).
 *
 * REPLACES `failures.slice(0, 3)`, which was the reporting half of the bug this
 * module's fourth failure rule describes: the ledger stored three strings, and
 * because the sweep polls Greenhouse first those three were always the same
 * harmless 404s. Thirty-six Recruitee rate limits per sweep never once appeared
 * anywhere the founder looks.
 *
 * Counts rather than names, because the founder's question is "is a platform
 * broken", not "which of 623 tokens". The names are still in the logs, and
 * `failures` itself is untouched for the callers that want them. Bounded on
 * purpose: a total outage must write a readable line to the ledger, not 623 of
 * them.
 */
export function summariseFailures(failures: readonly string[]): string {
  if (failures.length === 0) return "";

  const counts = new Map<string, number>();
  for (const failure of failures) {
    // Our own format, produced in sweepBoards: "<ats>/<token>: <error>".
    const match = /^([^/]+)\/[^:]*:\s*(.*)$/.exec(failure);
    const key = match ? `${match[1]} ${match[2]}` : failure;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const ranked = [...counts].sort((a, b) => b[1] - a[1]);
  const shown = ranked.slice(0, SUMMARY_PATTERN_CAP).map(([key, n]) => `${key} ×${n}`);
  const hidden = ranked.length - shown.length;
  if (hidden > 0) shown.push(`+${hidden} other pattern(s)`);

  return `${failures.length} board(s) failed: ${shown.join("; ")}`;
}
