/**
 * Apply answer page: reading a posted form
 * ========================================
 * Pure. The page posts hashed field names (applyFieldName); this maps each one back to a question
 * in the stored snapshot and refuses anything the page did not offer: an unknown field, a field
 * the page shows read-only (file, CAPTCHA, consent), an option answer that is not an exact member of the
 * question's options, an answer over the cap. Nothing from the form reaches the dossier unless it
 * passed here. Empty answers are skipped, not rejected, so a half-filled form saves what it has.
 *
 * The page also offers every value the bot filled as an input, and the browser posts all of them back.
 * A filled value only counts when the founder changed it: one posted back as it was is skipped before
 * any other check, so an old value that is over the cap or off its option list cannot block a save.
 */

import type { ApplySnapshot } from "../tools/jobhunt/apply-link.js";
import { MAX_ANSWER_CHARS, applyFieldName, editableFilled, isEditableQuestion } from "./apply-page.js";

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

/** What the page offered under one field name: an open question, or a value the bot filled. */
interface Offered {
  readonly label: string;
  readonly options?: readonly string[];
  /** Set for a filled value: posting it back unchanged is not an answer. */
  readonly current?: string;
}

/** Field name to what the page offered under it. An open question keeps a name a filled value would share. */
function offeredByName(snap: ApplySnapshot): Map<string, Offered> {
  const byName = new Map<string, Offered>();
  for (const q of snap.summary.unanswered) if (isEditableQuestion(q)) byName.set(applyFieldName(q.label), q);
  for (const f of editableFilled(snap.summary)) {
    byName.set(applyFieldName(f.label), { label: f.label, current: f.value, ...(f.options ? { options: f.options } : {}) });
  }
  return byName;
}

export function collectAnswers(snap: ApplySnapshot, params: URLSearchParams): CollectResult {
  const byName = offeredByName(snap);

  const picked = new Map<string, CollectedAnswer>();
  for (const [name, raw] of params.entries()) {
    const q = byName.get(name);
    if (!q) return { ok: false, error: "The form changed since this page loaded. Reload it from the latest Telegram card." };
    const answer = cleanAnswer(raw);
    if (answer.length === 0) continue;
    if (q.current !== undefined && answer === cleanAnswer(q.current)) continue;
    if (answer.length > MAX_ANSWER_CHARS) return { ok: false, error: `An answer is longer than ${MAX_ANSWER_CHARS} characters.` };
    if (q.options !== undefined && q.options.length > 0 && !q.options.includes(answer)) {
      return { ok: false, error: "One answer is not one of the offered options. Reload the page and pick again." };
    }
    picked.set(name, { label: q.label, answer });
  }
  return { ok: true, answers: [...picked.values()] };
}
