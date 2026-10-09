/**
 * Dictated email bodies
 * =====================
 * Live QA 2026-10-09: a mail to the founder's own address with "body exactly: ..." was blocked twice by the
 * outbound critic (it wanted agency warmth) and the card that finally appeared carried a rewritten body
 * ("Hi Pushkar ... Best regards"). When the founder writes the body, the body is his: no gate may block it
 * and no model may reword it. These are pure functions of the founder's own message, so the rule lives in code.
 */

/** "body exactly: ...", "body: ...", "the body is exactly - ..." (also "text"): the label, then everything after it. */
const BODY_LABEL =
  /\b(?:exact\s+)?(?:body|text)(?:\s+(?:is|should\s+be|to\s+be))?(?:\s+(?:exactly|verbatim|word[\s-]for[\s-]word|as[\s-]is))?\s*[:\-–—]\s*/i;

const QUOTES: ReadonlyArray<readonly [string, string]> = [
  ['"', '"'],
  ["“", "”"],
  ["'", "'"],
];

function unquote(s: string): string {
  const t = s.trim();
  for (const [open, close] of QUOTES) {
    if (t.length >= 2 && t.startsWith(open) && t.endsWith(close)) return t.slice(1, -1).trim();
  }
  return t;
}

/** The body the founder dictated in his message, or null when he did not label one. */
export function dictatedBodyFrom(founderText: string): string | null {
  const m = BODY_LABEL.exec(founderText);
  if (!m) return null;
  const body = unquote(founderText.slice(m.index + m[0].length));
  return body.length > 0 ? body : null;
}

const squash = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

/** The shortest body worth matching as "his words": a one-word body would match any message that mentions it. */
const MIN_VERBATIM_CHARS = 20;

/** True when the body the model passed is a verbatim slice of what the founder typed (so he wrote it). */
export function isVerbatimFromFounder(body: string, founderText: string): boolean {
  const b = squash(body);
  return b.length >= MIN_VERBATIM_CHARS && squash(founderText).includes(b);
}

/** The body to send and whether it is the founder's: his labelled text wins over the model's, else a verbatim match. */
export function resolveEmailBody(modelBody: string, founderText: string): { body: string; dictated: boolean } {
  const labelled = dictatedBodyFrom(founderText);
  if (labelled) return { body: labelled, dictated: true };
  return { body: modelBody, dictated: isVerbatimFromFounder(modelBody, founderText) };
}
