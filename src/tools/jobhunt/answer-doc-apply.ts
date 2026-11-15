/**
 * FounderOS — apply an imported answer document
 * =============================================
 * `applyPatch` is the pure state change; `importAnswerDoc` parses, maps and (only when asked) saves it through the
 * answer store, which backs up both answer files and writes them together, atomically. The Telegram command and
 * `scripts/import-answer-doc.ts` both come through here, so a dry run and a save can never disagree.
 */

import { saveAnswers, withLearnedAnswer, type AnswerState, type SaveResult } from "./answer-store.js";
import { parseAnswerDoc, type ParsedAnswer } from "./answer-doc-parse.js";
import { mapAnswersToProfile, type AnswerPatch, type FieldWrite } from "./answer-doc-map.js";

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** The answer state with every write in the patch applied. Pure. */
export function applyPatch(state: AnswerState, patch: AnswerPatch): AnswerState {
  const profile: Record<string, unknown> = { ...state.profile };
  const answers: Record<string, unknown> = { ...asRecord(profile["answers"]) };
  const selfId: Record<string, unknown> = { ...asRecord(answers["self_identification"]) };
  for (const w of patch.writes) {
    if (w.kind === "top") profile[w.field] = w.value;
    else if (w.kind === "selfid") selfId[w.category] = w.value;
    else if (w.kind === "answer") {
      if (w.value === null) delete answers[w.field];
      else answers[w.field] = w.value;
    }
  }
  if (Object.keys(selfId).length > 0) answers["self_identification"] = selfId;
  let next: AnswerState = { profile: { ...profile, answers }, dossierMarkdown: state.dossierMarkdown };
  for (const w of patch.writes) if (w.kind === "qa") next = withLearnedAnswer(next, w.question, w.value);
  return next;
}

export interface ImportOutcome {
  readonly parsed: readonly ParsedAnswer[];
  readonly patch: AnswerPatch;
  /** Set only when `apply` was true. */
  readonly saved?: SaveResult;
}

/** Parse and map `text`; save it for `profileId` only when `apply` is true. A patch with nothing to write is never saved. */
export async function importAnswerDoc(profileId: string, text: string, apply: boolean): Promise<ImportOutcome> {
  const parsed = parseAnswerDoc(text);
  const patch = mapAnswersToProfile(parsed);
  if (!apply || patch.writes.length === 0) return { parsed, patch };
  const saved = await saveAnswers(profileId, (s) => applyPatch(s, patch));
  return { parsed, patch, saved };
}

const WHERE: Record<FieldWrite["kind"], string> = { top: "profile", answer: "profile", selfid: "profile (voluntary)", qa: "dossier Q&A" };

/** Plain-text lines for a preview: every field the save will write, then what is held back. Values only when `showValues`. */
export function previewLines(patch: AnswerPatch, showValues: boolean): string[] {
  const shown = (w: FieldWrite): string => {
    if (!showValues) return "value hidden";
    const v = w.kind === "qa" || w.kind === "selfid" || w.kind === "top" ? w.value : w.value === null ? "(cleared)" : String(w.value);
    return v.length > 80 ? `${v.slice(0, 77)}...` : v;
  };
  const writes = patch.writes.map((w) => `Q${w.number} ${w.label} → ${WHERE[w.kind]}: ${shown(w)}`);
  const held = patch.held.map((h) => `Q${h.number} ${h.label}: ${h.reason}`);
  return [
    `Will write ${patch.writes.length} fields${showValues ? "" : " (values hidden in a group chat)"}`,
    ...writes,
    ...(held.length > 0 ? ["", `Not written (${held.length})`, ...held] : []),
  ];
}
