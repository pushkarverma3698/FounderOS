/**
 * FounderOS — how many needs_you rows only a fact sheet would unblock
 * ====================================================================
 * Groups the open required questions by row and asks fact-sheet.ts which category each one belongs to. A row is
 * "fact-sheet only" when every open question fits a category: filling the sheet could move it to auto. Rows with
 * any other question (a motivation essay, a custom question) are not counted. Wording is the only input; no
 * stored value is read, so this is safe to print.
 *
 * PURE (STANDARDS.md section 2).
 */

import { factCategoryOf } from "./fact-sheet.js";

export interface OpenQuestionRef {
  readonly rowId: string;
  readonly label: string;
}

export interface FactGap {
  readonly rows: number;
  /** Rows whose open questions are all fact-sheet categories. */
  readonly factOnlyRows: number;
  /** Per category key, how many fact-only rows ask for it. */
  readonly byCategory: Readonly<Record<string, number>>;
  /** Labels that fit no category, with how many rows ask them (the next candidates to add). */
  readonly otherLabels: Readonly<Record<string, number>>;
}

export function factGap(questions: readonly OpenQuestionRef[]): FactGap {
  const byRow = new Map<string, string[]>();
  for (const q of questions) byRow.set(q.rowId, [...(byRow.get(q.rowId) ?? []), q.label]);
  const byCategory: Record<string, number> = {};
  const otherLabels: Record<string, number> = {};
  let factOnlyRows = 0;
  for (const labels of byRow.values()) {
    const cats = labels.map((l) => factCategoryOf(l)?.key ?? null);
    for (let i = 0; i < labels.length; i++) if (cats[i] === null) otherLabels[labels[i]!] = (otherLabels[labels[i]!] ?? 0) + 1;
    if (cats.some((c) => c === null)) continue;
    factOnlyRows++;
    for (const key of new Set(cats as string[])) byCategory[key] = (byCategory[key] ?? 0) + 1;
  }
  return { rows: byRow.size, factOnlyRows, byCategory, otherLabels };
}

/** One printable block per profile. */
export function formatFactGap(profileId: string, gap: FactGap): string {
  const cats = Object.entries(gap.byCategory).sort((a, b) => b[1] - a[1]).map(([k, n]) => `  ${k}: ${n}`);
  return [`${profileId}: ${gap.factOnlyRows} of ${gap.rows} needs_you rows have only fact-sheet questions open`, ...cats].join("\n");
}
