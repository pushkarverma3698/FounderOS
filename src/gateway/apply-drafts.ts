/**
 * Apply drafts: wiring and Telegram text for suggested answers
 * =============================================================
 * `form-answer-drafts.ts` decides what a safe suggestion is. This file feeds it the profile and the
 * dossier, bounds it in time, and renders a suggestion under the question. Used only by the Telegram
 * question flow: shadow runs and the auto-send lane never call it.
 */

import type { InlineKeyboard } from "grammy";
import { invokeWorkerWithFallbacks } from "../agents/worker-invoke.js";
import { formAnswerDraftsEnabled } from "../core/config.js";
import { childLogger } from "../infra/logger.js";
import type { ApplyProfile } from "../tools/jobhunt/apply-profile.js";
import { normalizeQuestionKey, type CandidateDossier } from "../tools/jobhunt/candidate-dossier.js";
import { draftFormAnswers, isDraftable, type DraftModel, type QuestionDraft } from "../tools/jobhunt/form-answer-drafts.js";
import type { UnansweredQuestion } from "../tools/jobhunt/form-brain.js";
import { JOB_CALLBACK_PREFIX } from "../tools/jobhunt/job-ref.js";
import { safeHtml } from "./safe-html.js";

const log = childLogger({ module: "gateway:apply-drafts" });
export const DRAFT_TIMEOUT_MS = 20_000;

export type DraftMap = Readonly<Record<string, QuestionDraft>>;
export type DraftResolver = (questions: readonly UnansweredQuestion[], profile: ApplyProfile, dossier?: CandidateDossier) => Promise<DraftMap>;

const NEVER_IN_SOURCE = /salary|work_authorization|auto_consent|self_id|visa|sponsor/i;
const PRIVATE_LINE = /@[\w-]+\.\w|(?:\d[\s().-]?){9,}|\b(?:phone|mobile|e-?mail|upi|address|date of birth|dob|passport)\b/i;

/** The only text the model sees, and the text every sourceQuote is checked against. Contact details are left out. */
export function draftSourceText(profile: ApplyProfile, dossier?: CandidateDossier): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(profile.answers ?? {})) {
    if (!NEVER_IN_SOURCE.test(k) && (typeof v === "string" || typeof v === "number" || typeof v === "boolean")) lines.push(`${k.replace(/_/g, " ")}: ${String(v)}`);
  }
  for (const [q, a] of Object.entries(profile.question_bank ?? {})) lines.push(`${q}: ${a}`);
  if (dossier?.rawText) lines.push(dossier.rawText);
  // Line by line, so a salary, visa or contact line in the question bank or the dossier never reaches the model either.
  return lines.join("\n").split("\n").filter((l) => !PRIVATE_LINE.test(l) && isDraftable({ label: l, fieldType: "text" })).join("\n");
}

const worker: DraftModel = { invoke: (messages) => invokeWorkerWithFallbacks(messages, { attribution: { agent: "jobhunt", stage: "worker" } }) };

/** Production resolver: flag off, no questions, an error or the time cap all mean no drafts. */
export const resolveFormDrafts: DraftResolver = async (questions, profile, dossier) => {
  if (!formAnswerDraftsEnabled() || questions.length === 0) return {};
  let timer: NodeJS.Timeout | undefined;
  try {
    const cap = new Promise<DraftMap>((resolve) => {
      timer = setTimeout(() => resolve({}), DRAFT_TIMEOUT_MS);
    });
    return await Promise.race([draftFormAnswers(questions, draftSourceText(profile, dossier), worker), cap]);
  } catch (err) {
    // allow-failopen: a suggestion is a convenience; on any failure the plain question is asked.
    log.warn({ err: (err as Error).message }, "form answer drafts failed; asking plain questions");
    return {};
  } finally {
    if (timer) clearTimeout(timer);
  }
};

export const draftFor = (drafts: DraftMap | undefined, q: UnansweredQuestion): QuestionDraft | undefined => drafts?.[normalizeQuestionKey(q.label)];

/** Lines shown under the question. */
export function draftLines(d: QuestionDraft): string {
  return `\n\n💡 Suggested: <code>${safeHtml(d.answer)}</code>\nFrom your profile: "${safeHtml(d.sourceQuote.slice(0, 200))}"`;
}

/** The extra button; `qTag` carries the card stamp, so a tap on a superseded card is refused like any answer tap. */
export function addUseSuggestion(kb: InlineKeyboard, rowId: string, qTag: string): InlineKeyboard {
  return kb.text("✅ Use suggestion", `${JOB_CALLBACK_PREFIX}q:${rowId}:use${qTag}`).row();
}
