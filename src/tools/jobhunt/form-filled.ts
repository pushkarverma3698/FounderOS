/**
 * FounderOS — Filled answers (what the bot typed, for the hosted apply page)
 * ==========================================================================
 * Pure. `summariseFormPlan` calls `filledAnswerOf` once per field the bot filled, so the answer page
 * can show the value next to the label instead of the label alone. A value is the text typed, the
 * option chosen, or the attachment's file NAME (never its path, which holds the local directory).
 *
 * `editable` says whether the page may offer the value as an input. Saving an edit records
 * `question_bank[label] = answer`, which wins on the next re-fill (`explicitAnswerFor`), so a field is
 * editable only when that round trip is safe:
 *  - the label is the scraped label, not a made-up fallback, so the next scrape asks the same question;
 *  - the value is one line within the cap, because the stored answer is one line;
 *  - it is not a file, a CAPTCHA, a consent checkbox or a single checkbox, none of which is typed text.
 */

import type { FormFillAction, ScrapedField, ScrapedFieldKind } from "./form-brain.js";

/** Longest answer the page accepts or offers (the same cap `apply-answers` enforces on a post). */
export const MAX_ANSWER_CHARS = 2000;

export interface FilledAnswer {
  readonly label: string;
  readonly value: string;
  readonly fieldType: ScrapedFieldKind;
  readonly options?: readonly string[];
  readonly editable: boolean;
}

type FilledAction = Exclude<FormFillAction, { kind: "ask" }>;

/** The last segment of a posix or a windows path. */
function fileNameOf(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] ?? filePath;
}

function valueOf(action: FilledAction): string {
  return action.kind === "value" ? action.value : action.kind === "choose" ? action.option : fileNameOf(action.path);
}

function hasLineBreak(value: string): boolean {
  return /[\r\n]/.test(value);
}

export function filledAnswerOf(action: FilledAction, fields: readonly ScrapedField[]): FilledAnswer {
  const field = fields.find((f) => f.selector === action.selector);
  const fieldType: ScrapedFieldKind = action.kind === "file" ? "file" : action.kind === "choose" ? action.fieldType : (field?.type ?? "text");
  const value = valueOf(action);
  const typed = fieldType !== "file" && fieldType !== "captcha" && fieldType !== "checkbox";
  const editable =
    typed &&
    field !== undefined &&
    field.label.trim() !== "" &&
    field.isConsent !== true &&
    !hasLineBreak(value) &&
    value.length <= MAX_ANSWER_CHARS;
  return {
    label: action.label,
    value,
    fieldType,
    ...(field?.options && field.options.length > 0 ? { options: [...field.options] } : {}),
    editable,
  };
}
