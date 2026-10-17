/**
 * Apply answer page: reading a posted form
 * ========================================
 * Pure. The page posts hashed field names (applyFieldName); this maps each one back to a question
 * in the stored snapshot and refuses anything the page did not offer: an unknown field, a field
 * the page shows read-only (file, CAPTCHA), an option answer that is not an exact member of the
 * question's options, an answer over the cap. Nothing from the form reaches the dossier unless it
 * passed here. Empty answers are skipped, not rejected, so a half-filled form saves what it has.
 */

import type { ApplySnapshot, ApplySnapshotQuestion } from "../tools/jobhunt/apply-link.js";
import { MAX_ANSWER_CHARS, READ_ONLY_FIELD_TYPES, applyFieldName } from "./apply-page.js";

export interface CollectedAnswer {
  readonly label: string;
  readonly answer: string;
}

export type CollectResult =
  | { readonly ok: true; readonly answers: readonly CollectedAnswer[] }
  | { readonly ok: false; readonly error: string };

/**
 * One line, control characters dropped, edges trimmed. A textarea answer arrives with line breaks, but the
 * dossier stores one answer per line and reads a later line as its own entry, so breaks become single spaces.
 */
function cleanAnswer(raw: string): string {
  let out = "";
  let pendingBreak = false;
  for (const ch of raw) {
    const code = ch.charCodeAt(0);
    if (code === 10 || code === 13 || code === 9) {
      pendingBreak = true;
    } else if (code >= 32 && code !== 127) {
      if (pendingBreak && out.length > 0) out += " ";
      pendingBreak = false;
      out += ch;
    }
  }
  return out.trim();
}

function editable(q: ApplySnapshotQuestion): boolean {
  return !READ_ONLY_FIELD_TYPES.has(q.fieldType);
}

export function collectAnswers(snap: ApplySnapshot, params: URLSearchParams): CollectResult {
  const byName = new Map<string, ApplySnapshotQuestion>();
  for (const q of snap.summary.unanswered) if (editable(q)) byName.set(applyFieldName(q.label), q);

  const picked = new Map<string, CollectedAnswer>();
  for (const [name, raw] of params.entries()) {
    const q = byName.get(name);
    if (!q) return { ok: false, error: "The form changed since this page loaded. Reload it from the latest Telegram card." };
    const answer = cleanAnswer(raw);
    if (answer.length === 0) continue;
    if (answer.length > MAX_ANSWER_CHARS) return { ok: false, error: `An answer is longer than ${MAX_ANSWER_CHARS} characters.` };
    if (q.options !== undefined && q.options.length > 0 && !q.options.includes(answer)) {
      return { ok: false, error: "One answer is not one of the offered options. Reload the page and pick again." };
    }
    picked.set(name, { label: q.label, answer });
  }
  return { ok: true, answers: [...picked.values()] };
}
