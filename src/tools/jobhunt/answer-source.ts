/**
 * Where a filled answer came from (read by auto-send, ADR-018 amendment 2026-11-15)
 * ================================================================================
 * PURE. The form brain is deterministic and records WHY it chose each value (`FormFillAction.why`). Auto-send
 * only trusts an answer whose reason it recognises: anything else is "unknown" and keeps the row off the
 * auto lane. A new `why` string added to the form brain is therefore blocked until it is listed here.
 *
 *   profile   a value the candidate stated in apply-profile.json (contact fields, work authorisation, notice, consent)
 *   dossier   the candidate dossier (facts, Q&A, rules)
 *   approved  the question bank: an answer the candidate gave and approved
 *   file      the resume or cover-letter upload
 *   letter    the cover-letter text, written and fact-checked by the letter writer
 *   factsheet a value the founder typed once into the Mini App fact sheet (fact-sheet.ts), "fact sheet (<key>)"
 *   policy    the "decline to self-identify" default, a fixed rule and never a guess
 *   unknown   anything else; never qualifies
 */

export type AnswerSource = "profile" | "dossier" | "approved" | "file" | "letter" | "policy" | "factsheet" | "unknown";

/** Sources that count as "an answer he approved or stated". */
export const TRUSTED_SOURCES: ReadonlySet<AnswerSource> = new Set(["profile", "dossier", "approved", "file", "letter", "policy", "factsheet"]);

/** Fills that name his right to work, a visa or a self-identification: only these sources may answer them. */
const SENSITIVE_LABEL =
  /visa|sponsor|work (?:authori[sz]ation|permit)|right to work|eligib|legally|citizen|gender|ethnic|race|disabilit|veteran|hispanic|lgbt|sexual|pronoun/i;
const SENSITIVE_SOURCES: ReadonlySet<AnswerSource> = new Set(["profile", "dossier", "approved", "policy", "factsheet"]);

export function answerSourceOf(why: string): AnswerSource {
  if (/^explicitly answered in candidate question bank/.test(why) || why.startsWith("question_bank (")) return "approved";
  if (why.startsWith("dossier Q&A (") || why.startsWith("dossier fact (") || why.startsWith("dossier/profile rule (")) return "dossier";
  if (/^fact sheet \([a-z_.0-9-]+\)$/.test(why)) return "factsheet";
  if (why === "matched cover-letter text field") return "letter";
  if (why === "cover-letter file upload field" || why === "resume/CV upload field") return "file";
  if (why.startsWith("voluntary self-identification") && why.includes("declined: no ")) return "policy";
  if (
    why === "profile notice period" ||
    why === "profile years of experience" ||
    why === "auto_consent enabled in candidate profile" ||
    /^matched [\w/ -]+ field$/.test(why) ||
    /^work_authorization=\S+ (?:answered|matched) /.test(why) ||
    /^answers\.self_identification\.\w+ (?:declines|in the candidate profile)$/.test(why)
  ) {
    return "profile";
  }
  return "unknown";
}

/** True when this filled answer may go out without a person looking at it. */
export function isTrustedAnswer(answer: { readonly label: string; readonly source?: AnswerSource; readonly confidence?: number }): boolean {
  const source = answer.source ?? "unknown";
  if (!TRUSTED_SOURCES.has(source)) return false;
  if ((answer.confidence ?? 0) < MIN_CONFIDENCE) return false;
  return !SENSITIVE_LABEL.test(answer.label) || SENSITIVE_SOURCES.has(source);
}

export const MIN_CONFIDENCE = 0.9;
