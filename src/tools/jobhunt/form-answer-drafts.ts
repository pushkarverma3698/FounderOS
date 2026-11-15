/**
 * Form answer drafts
 * ==================
 * The form filler answers from fixed rules; every job-specific question the rules cannot answer
 * ("years of AWS", "ok with 3 days in the Pune office", "how did you hear about us") became a typed
 * reply in Telegram. This module asks ONE model call per form for a suggested answer to each such
 * question, and keeps only the suggestions the code can verify.
 *
 * A draft is a suggestion, never an answer: the founder taps "Use suggestion" and it then travels the
 * same path as a typed reply. Shadow runs and the auto-send lane never read drafts.
 *
 * Enforced in code, not in the prompt (rule #27):
 *  - no verbatim `sourceQuote` from the profile or dossier text the model was given: no draft;
 *  - a question with options: the answer must be one of the options;
 *  - never sent to the model at all: file fields, sensitive / visa / self-identification / consent /
 *    legal questions, salary questions (ADR-018: those come from the profile, dossier or question bank).
 */

import { matchChoiceOption, normalizeQuestionKey } from "./candidate-dossier.js";
import type { ChatTurn, CoverLetterModel } from "./cover-letter.js";
import type { ScrapedFieldKind } from "./form-brain.js";
import { isSensitiveQuestion } from "./open-questions.js";

export type DraftModel = CoverLetterModel;

export interface DraftQuestion {
  readonly label: string;
  readonly fieldType: ScrapedFieldKind;
  readonly options?: readonly string[];
}

export interface QuestionDraft {
  readonly answer: string;
  readonly sourceQuote: string;
}

export interface RawDraft {
  readonly index: number;
  readonly answer: string;
  readonly sourceQuote: string;
}

/** Enough source to answer from; short enough not to blow the context. */
export const SOURCE_CHARS = 12000;
const MAX_ANSWER_CHARS = 500;
const MIN_QUOTE_CHARS = 4;

const NEVER_DRAFT =
  /\b(visas?|work (?:authori[sz]ation|permit)|right to work|authori[sz]ed to work|eligible to work|legally|sponsor\w*|immigration|citizen\w*|gender|sex|race|racial|ethnic\w*|disabilit\w*|veteran|pronouns?|sexual orientation|religio\w*|consent|agree|acknowledge|certify|declar\w+|terms|privacy|gdpr|non-?compete|criminal|conviction|background check|salary|salaries|compensation|remuneration|ctc|pay (?:expectation|range)|expected pay|hourly rate|day rate|rate expectation)\b/i;

/** True when a question may be sent to the model. Everything else keeps coming from profile, dossier or the founder. */
export function isDraftable(q: DraftQuestion): boolean {
  if (q.fieldType === "file" || q.fieldType === "captcha" || q.fieldType === "checkbox" || q.fieldType === "checkbox-group") return false;
  if (isSensitiveQuestion(q.label)) return false;
  return !NEVER_DRAFT.test(q.label) && !(q.options ?? []).some((o) => NEVER_DRAFT.test(o));
}

const SYSTEM_PROMPT = `You suggest answers to job application form questions on behalf of a candidate.

RULES
1. Use ONLY the SOURCE text. Never infer, round up or guess a fact, a year count or a preference.
2. For each question you can answer from the SOURCE, return the answer and a sourceQuote copied
   character for character from the SOURCE that supports it.
3. If the SOURCE does not clearly answer a question, leave it out. Leaving it out is correct.
4. For a question with OPTIONS, the answer must be exactly one of the options.
5. Answers are short: a few words, or at most two sentences for a free-text question.

Reply with JSON only, no prose and no code fence:
{"drafts":[{"index":0,"answer":"...","sourceQuote":"..."}]}`;

/** The user turn. Indices are positions in `questions`, so the reply cannot mislabel a question. */
export function buildDraftPrompt(questions: readonly DraftQuestion[], sourceText: string): ChatTurn[] {
  const asked = questions.map((q, index) => {
    const opts = q.options && q.options.length > 0 ? ` OPTIONS: ${q.options.map((o) => JSON.stringify(o)).join(" | ")}` : "";
    return `${index}. [${q.fieldType}] ${q.label}${opts}`;
  });
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `SOURCE:\n${sourceText.slice(0, SOURCE_CHARS)}\n\nQUESTIONS:\n${asked.join("\n")}` },
  ];
}

const unfence = (raw: string): string =>
  raw.replace(/^\s*```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();

/** Strict parse: anything that is not the documented shape yields no drafts, never a throw. */
export function parseDraftResponse(raw: string): RawDraft[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfence(raw));
  } catch {
    // allow-failopen: malformed model output means no suggestions; the plain question is still asked.
    return [];
  }
  const list = typeof parsed === "object" && parsed !== null ? (parsed as { drafts?: unknown }).drafts : undefined;
  if (!Array.isArray(list)) return [];
  const out: RawDraft[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const { index, answer, sourceQuote } = item as Record<string, unknown>;
    if (typeof index !== "number" || !Number.isInteger(index) || typeof answer !== "string" || typeof sourceQuote !== "string") continue;
    out.push({ index, answer, sourceQuote });
  }
  return out;
}

const squash = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Keeps only drafts whose quote is in the source and whose answer fits the question. Keyed by question index. */
export function validateDrafts(
  raw: readonly RawDraft[],
  questions: readonly DraftQuestion[],
  sourceText: string,
): Map<number, QuestionDraft> {
  const haystack = squash(sourceText.slice(0, SOURCE_CHARS));
  const kept = new Map<number, QuestionDraft>();
  for (const d of raw) {
    const q = questions[d.index];
    if (!q || kept.has(d.index) || !isDraftable(q)) continue;
    const quote = d.sourceQuote.trim();
    if (squash(quote).length < MIN_QUOTE_CHARS || !haystack.includes(squash(quote))) continue;
    let answer = d.answer.trim();
    if (answer.length === 0 || answer.length > MAX_ANSWER_CHARS) continue;
    if (q.options && q.options.length > 0) {
      const matched = matchChoiceOption(answer, q.options);
      if (matched === null) continue;
      answer = matched;
    }
    kept.set(d.index, { answer, sourceQuote: quote });
  }
  return kept;
}

/**
 * One model call for the whole form. Returns drafts keyed by `normalizeQuestionKey(label)`.
 * Throws only what the model throws; the caller decides the fallback.
 */
export async function draftFormAnswers(
  questions: readonly DraftQuestion[],
  sourceText: string,
  model: DraftModel,
): Promise<Record<string, QuestionDraft>> {
  const askable = questions.filter(isDraftable);
  if (askable.length === 0 || sourceText.trim().length === 0) return {};
  const reply = await model.invoke(buildDraftPrompt(askable, sourceText));
  const text = typeof reply.content === "string" ? reply.content : JSON.stringify(reply.content);
  const kept = validateDrafts(parseDraftResponse(text), askable, sourceText);
  const out: Record<string, QuestionDraft> = {};
  for (const [index, draft] of kept) out[normalizeQuestionKey(askable[index]!.label)] = draft;
  return out;
}
