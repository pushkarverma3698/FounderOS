/**
 * Saved-answers editor: the dossier Core Facts lines, for display
 * ================================================================
 * Read-only mirror of "## Core Facts" in the candidate dossier (the lines SEMANTIC_RULES read first), so the
 * editor can show that a salary or notice-period change reached the text a form is filled from.
 *
 * PURE (STANDARDS.md section 2).
 */

import { BOLD_KV } from "../tools/jobhunt/candidate-dossier.js";

export interface CoreFact {
  readonly label: string;
  readonly value: string;
}

export function coreFactsOf(markdown: string): CoreFact[] {
  const out: CoreFact[] = [];
  let inCore = false;
  for (const line of markdown.split("\n")) {
    const heading = /^#{1,3}\s+(.+)$/.exec(line.trim());
    if (heading) {
      inCore = heading[1]!.trim().toLowerCase() === "core facts";
      continue;
    }
    if (!inCore) continue;
    const m = BOLD_KV.exec(line.trim());
    if (m) out.push({ label: m[1]!.trim(), value: m[2]!.trim() });
  }
  return out;
}
