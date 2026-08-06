/**
 * M0a — Evolution Engine v0: findings ranker.
 * ============================================
 * Pure total ordering over findings. Orders findings by severity descending,
 * kind priority ascending, and subject alphabetically.
 */

import type { Finding, FindingKind, Severity } from "./types.js";

/** Severity ordering. Higher sorts first. */
export const SEVERITY_RANK: Readonly<Record<Severity, number>> = { high: 3, medium: 2, low: 1 };

/**
 * Findings ordered by how directly acting on one changes an outcome.
 * Money and silent defects first; risk and tidiness last. A finding nobody
 * can act on this week ranks below one that can be fixed by deleting a line.
 */
export const KIND_PRIORITY: readonly FindingKind[] = [
  "unapplied-lesson",
  "cost-hotspot",
  "recurring-failure",
  "unused-dependency",
  "orphan-module",
  "dead-export",
  "oversized-prompt",
  "loc-pressure",
  "untested-module",
];

/**
 * Helper to get index in KIND_PRIORITY.
 * Unknown kinds sort last (at KIND_PRIORITY.length).
 */
function getKindPriorityIndex(kind: FindingKind): number {
  const index = KIND_PRIORITY.indexOf(kind);
  return index === -1 ? KIND_PRIORITY.length : index;
}

/**
 * Rank findings by severity descending, kind priority ascending, and subject ascending.
 * Returns a new array; does not mutate the input array.
 */
export function rankFindings(findings: readonly Finding[]): Finding[] {
  const sorted = findings.slice();

  sorted.sort((a, b) => {
    // 1. Severity descending
    const sevA = SEVERITY_RANK[a.severity];
    const sevB = SEVERITY_RANK[b.severity];
    if (sevA !== sevB) {
      return sevB - sevA;
    }

    // 2. Kind priority ascending
    const kindA = getKindPriorityIndex(a.kind);
    const kindB = getKindPriorityIndex(b.kind);
    if (kindA !== kindB) {
      return kindA - kindB;
    }

    // 3. Subject ascending. Codepoint order, not localeCompare: this tiebreak
    //    exists only to make the order total and reproducible, and localeCompare
    //    varies with the host's ICU build.
    if (a.subject < b.subject) return -1;
    if (a.subject > b.subject) return 1;
    return 0;
  });

  return sorted;
}
